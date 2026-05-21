"""
Weather Service for Crop Disease Intelligence Platform
=======================================================

Fetches real-time and forecast weather data from Open-Meteo API.
Provides caching, retry logic, and graceful fallbacks.

Author: Crop Intelligence Team
Version: 2.1
"""

import os
import json
import logging
import hashlib
from datetime import datetime, timedelta
from typing import Dict, Optional, Tuple, Any
from time import sleep

import requests

# Configure logger
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ============================================================================
# CONFIGURATION
# ============================================================================

# Cache configuration (reduces API calls, improves performance)
CACHE_ENABLED = os.environ.get('WEATHER_CACHE_ENABLED', 'true').lower() == 'true'
CACHE_TTL_SECONDS = int(os.environ.get('WEATHER_CACHE_TTL', 1800))  # 30 minutes
CACHE_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'cache')

# API configuration
API_TIMEOUT = int(os.environ.get('WEATHER_API_TIMEOUT', 10))
MAX_RETRIES = int(os.environ.get('WEATHER_MAX_RETRIES', 3))
RETRY_DELAY_SECONDS = int(os.environ.get('WEATHER_RETRY_DELAY', 1))
OPEN_METEO_BASE_URL = "https://api.open-meteo.com/v1/forecast"

# Seasonal temperature adjustments by month (North India reference)
SEASONAL_TEMP = {
    1: 15, 2: 18, 3: 24, 4: 30, 5: 34, 6: 36,
    7: 33, 8: 32, 9: 31, 10: 28, 11: 22, 12: 17
}

SEASONAL_HUMIDITY = {
    1: 75, 2: 70, 3: 60, 4: 45, 5: 40, 6: 55,
    7: 80, 8: 82, 9: 78, 10: 70, 11: 72, 12: 74
}

SEASONAL_WIND = {
    1: 8, 2: 9, 3: 10, 4: 12, 5: 14, 6: 15,  # Summer: higher wind
    7: 16, 8: 15, 9: 12, 10: 9, 11: 8, 12: 8   # Monsoon/Winter: variable
}


def _ensure_cache_dir():
    """Create cache directory if it doesn't exist."""
    if CACHE_ENABLED:
        os.makedirs(CACHE_DIR, exist_ok=True)


def _get_cache_key(lat: float, lng: float) -> str:
    """Generate cache key from coordinates."""
    coord_str = f"{lat:.4f},{lng:.4f}"
    return hashlib.md5(coord_str.encode()).hexdigest()


def _get_cached_weather(cache_key: str) -> Optional[Dict]:
    """Retrieve cached weather data if still valid."""
    if not CACHE_ENABLED:
        return None
    
    cache_file = os.path.join(CACHE_DIR, f"{cache_key}.json")
    
    try:
        if os.path.exists(cache_file):
            with open(cache_file, 'r', encoding='utf-8') as f:
                cached = json.load(f)
            
            cached_time = datetime.fromisoformat(cached.get('cached_at', '2000-01-01'))
            age_seconds = (datetime.now() - cached_time).total_seconds()
            
            if age_seconds < CACHE_TTL_SECONDS:
                logger.debug(f"Cache hit for {cache_key} (age: {age_seconds:.0f}s)")
                return cached.get('data')
    except Exception as e:
        logger.warning(f"Cache read error: {e}")
    
    return None


def _set_cached_weather(cache_key: str, data: Dict):
    """Store weather data in cache."""
    if not CACHE_ENABLED:
        return
    
    cache_file = os.path.join(CACHE_DIR, f"{cache_key}.json")
    
    try:
        cache_entry = {
            'cached_at': datetime.now().isoformat(),
            'data': data,
            'ttl_seconds': CACHE_TTL_SECONDS
        }
        with open(cache_file, 'w', encoding='utf-8') as f:
            json.dump(cache_entry, f, indent=2)
    except Exception as e:
        logger.warning(f"Cache write error: {e}")


def _calculate_leaf_wetness(humidity: float) -> float:
    """
    Calculate leaf wetness duration from humidity.
    
    Args:
        humidity: Relative humidity percentage (0-100)
        
    Returns:
        Estimated leaf wetness in hours (0-12)
    """
    if humidity > 85:
        return min(12, (humidity - 70) / 2.5)
    elif humidity > 75:
        return min(10, (humidity - 70) / 2)
    elif humidity > 65:
        return (humidity - 65) / 3
    else:
        return 0.0


def fetch_live_weather(lat: float, lng: float, force_refresh: bool = False) -> Dict:
    """
    Fetch live weather data from Open-Meteo API with caching and retries.
    
    Args:
        lat: Latitude (decimal degrees)
        lng: Longitude (decimal degrees)
        force_refresh: If True, bypass cache
        
    Returns:
        Dictionary with weather data (always returns valid data, uses fallback if needed)
    """
    logger.info(f"Fetching weather for coordinates: ({lat}, {lng})")
    
    # Validate coordinates
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        logger.error(f"Invalid coordinates: lat={lat}, lng={lng}")
        return _get_fallback_weather(lat, lng, reason="invalid_coordinates")
    
    if lat < -90 or lat > 90 or lng < -180 or lng > 180:
        logger.error(f"Coordinates out of range: lat={lat}, lng={lng}")
        return _get_fallback_weather(lat, lng, reason="out_of_range")
    
    _ensure_cache_dir()
    cache_key = _get_cache_key(lat, lng)
    
    # Check cache
    if not force_refresh and CACHE_ENABLED:
        cached_data = _get_cached_weather(cache_key)
        if cached_data:
            logger.info(f"Using cached weather")
            return cached_data
    
    # Attempt API fetch with retries
    weather_data = None
    last_error = None
    
    for attempt in range(MAX_RETRIES):
        try:
            weather_data = _fetch_from_open_meteo(lat, lng)
            if weather_data:
                logger.info(f"Successfully fetched live weather on attempt {attempt + 1}")
                break
        except requests.exceptions.Timeout as e:
            last_error = f"Timeout: {e}"
            logger.warning(f"Attempt {attempt + 1}/{MAX_RETRIES} timeout")
        except requests.exceptions.ConnectionError as e:
            last_error = f"Connection error: {e}"
            logger.warning(f"Attempt {attempt + 1}/{MAX_RETRIES} connection error")
        except Exception as e:
            last_error = f"Error: {e}"
            logger.warning(f"Attempt {attempt + 1}/{MAX_RETRIES} failed: {e}")
        
        if attempt < MAX_RETRIES - 1:
            delay = RETRY_DELAY_SECONDS * (2 ** attempt)
            sleep(delay)
    
    if weather_data:
        weather_data['source'] = 'open-meteo'
        weather_data['is_fallback'] = False
        weather_data['fetched_at'] = datetime.now().isoformat()
        _set_cached_weather(cache_key, weather_data)
        return weather_data
    
    logger.error(f"All {MAX_RETRIES} attempts failed: {last_error}")
    return _get_fallback_weather(lat, lng, reason=last_error or "api_failure")


def _fetch_from_open_meteo(lat: float, lng: float) -> Optional[Dict]:
    """Make actual API call to Open-Meteo."""
    params = {
        'latitude': lat,
        'longitude': lng,
        'current': 'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m',
        'daily': 'precipitation_sum,relative_humidity_2m_max',
        'forecast_days': 7,
        'timezone': 'auto'
    }
    
    response = requests.get(OPEN_METEO_BASE_URL, params=params, timeout=API_TIMEOUT)
    response.raise_for_status()
    
    data = response.json()
    
    if 'current' not in data:
        raise ValueError("Missing 'current' field in API response")
    
    current = data['current']
    temp = current.get('temperature_2m')
    humidity = current.get('relative_humidity_2m')
    rainfall = current.get('precipitation', 0)
    wind_speed = current.get('wind_speed_10m', 0)
    
    if temp is None or humidity is None:
        raise ValueError(f"Incomplete data: temp={temp}, humidity={humidity}")
    
    # Calculate leaf wetness from humidity
    leaf_wetness = _calculate_leaf_wetness(float(humidity))
    
    daily_data = data.get('daily', {})
    forecast_rain_3d = sum(daily_data.get('precipitation_sum', [0, 0, 0])[:3])
    
    return {
        'temperature_avg': round(float(temp), 1),
        'humidity_avg': round(float(humidity), 1),
        'rainfall_mm': round(float(rainfall), 1),
        'leaf_wetness_hours': round(leaf_wetness, 1),
        'forecast_3d_rain': round(forecast_rain_3d, 1),
        'wind_speed': round(float(wind_speed), 1)
    }


def _get_fallback_weather(lat: float, lng: float, reason: str = "unknown") -> Dict:
    """
    Generate realistic fallback weather data based on season and location.
    
    Args:
        lat: Latitude (for regional adjustment)
        lng: Longitude (for regional adjustment)
        reason: Reason for using fallback
        
    Returns:
        Complete weather dictionary with all required fields
    """
    current_month = datetime.now().month
    
    # Seasonal base values
    base_temp = SEASONAL_TEMP.get(current_month, 25)
    base_humidity = SEASONAL_HUMIDITY.get(current_month, 65)
    base_wind = SEASONAL_WIND.get(current_month, 10)
    
    # Latitude adjustment (cooler in north, warmer in south)
    # India ranges from ~8°N to ~37°N
    lat_factor = max(0.7, min(1.2, 1.0 - (abs(lat) - 20) / 50))
    adjusted_temp = round(base_temp * lat_factor, 1)
    
    # Humidity adjustment by latitude (coastal areas more humid)
    # Simplified: lower latitudes (south) generally more humid
    humidity_factor = max(0.8, min(1.2, 1.0 + (20 - abs(lat)) / 100))
    adjusted_humidity = min(95, round(base_humidity * humidity_factor))
    
    # Calculate leaf wetness from adjusted humidity
    leaf_wetness = _calculate_leaf_wetness(adjusted_humidity)
    
    # Wind speed adjustment (higher in coastal areas, during monsoon)
    if current_month in [6, 7, 8, 9]:  # Monsoon season
        wind_factor = 1.3
    elif current_month in [3, 4, 5]:  # Summer
        wind_factor = 1.1
    else:
        wind_factor = 0.9
    
    adjusted_wind = round(base_wind * wind_factor, 1)
    
    result = {
        'temperature_avg': adjusted_temp,
        'humidity_avg': adjusted_humidity,
        'rainfall_mm': 0.0,
        'leaf_wetness_hours': round(leaf_wetness, 1),
        'forecast_3d_rain': 0.0,
        'wind_speed': adjusted_wind,
        'source': 'fallback',
        'is_fallback': True,
        'fallback_reason': reason
    }
    
    logger.warning(
        f"Using fallback weather: {reason} — "
        f"temp={adjusted_temp}°C, humidity={adjusted_humidity}%, "
        f"wind={adjusted_wind}km/h, leaf_wetness={leaf_wetness:.1f}h"
    )
    return result


def get_weather_risk_level(weather_data: Dict) -> Dict[str, Any]:
    """
    Get human-readable weather risk assessment for UI.
    
    Args:
        weather_data: Weather dictionary from fetch_live_weather()
        
    Returns:
        Dictionary with risk level, icon, color, and actionable advice
    """
    if not weather_data:
        return {
            'level': 'UNKNOWN',
            'icon': '❓',
            'color': 'gray',
            'advice': 'Weather data unavailable. Use local observations.',
            'humidity': 65,
            'temperature': 25,
            'rainfall': 0
        }
    
    humidity = weather_data.get('humidity_avg', 65)
    temp = weather_data.get('temperature_avg', 25)
    rain = weather_data.get('rainfall_mm', 0)
    forecast_rain = weather_data.get('forecast_3d_rain', 0)
    leaf_wetness = weather_data.get('leaf_wetness_hours', 0)
    
    # Determine risk level
    if humidity > 80 and 22 < temp < 30:
        level = 'CRITICAL'
        icon = '🔴'
        color = 'red'
        advice = '⚠️ CRITICAL: High humidity + optimal temperature creates perfect conditions for fungal disease outbreak. Apply preventive fungicide within 24 hours.'
    elif humidity > 75 or (humidity > 70 and rain > 5):
        level = 'HIGH'
        icon = '🟠'
        color = 'orange'
        advice = '⚠️ HIGH: Elevated humidity increases disease pressure. Scout fields and consider preventive spray if crop is at vulnerable stage.'
    elif humidity > 65 or forecast_rain > 10:
        level = 'MODERATE'
        icon = '🟡'
        color = 'yellow'
        advice = '📊 MODERATE: Conditions are becoming favorable for disease. Monitor weather updates and crop stage.'
    else:
        level = 'LOW'
        icon = '🟢'
        color = 'green'
        advice = '✅ LOW: Current weather unfavorable for disease development. Routine monitoring sufficient.'
    
    # Add leaf wetness warning
    if leaf_wetness > 6:
        advice += f' 💧 Prolonged leaf wetness ({leaf_wetness:.0f}h) ideal for spore germination.'
    elif leaf_wetness > 3:
        advice += f' 💧 Leaf wetness duration ({leaf_wetness:.0f}h) supports moderate disease risk.'
    
    # Add forecast warning
    if forecast_rain > 15:
        advice += f' 🌧️ Heavy rain forecast ({forecast_rain:.0f}mm in 3 days) — ensure drainage and consider pre-rain application.'
    elif forecast_rain > 5:
        advice += f' 🌦️ Light rain expected ({forecast_rain:.0f}mm in 3 days) — may increase leaf wetness duration.'
    
    return {
        'level': level,
        'icon': icon,
        'color': color,
        'advice': advice,
        'humidity': round(humidity, 1),
        'temperature': round(temp, 1),
        'rainfall': round(rain, 1),
        'leaf_wetness': round(leaf_wetness, 1),
        'forecast_rain': round(forecast_rain, 1)
    }


# For backward compatibility with existing code
def fetch_weather_with_fallback(lat: float, lng: float) -> Dict:
    """Wrapper for backward compatibility."""
    return fetch_live_weather(lat, lng)


# Helper function to get complete weather for frontend
def get_weather_for_frontend(lat: float, lng: float) -> Dict:
    """
    Get complete weather data formatted for frontend display.
    
    Args:
        lat: Latitude
        lng: Longitude
        
    Returns:
        Dictionary with 'current' and 'risk' keys for frontend
    """
    weather_data = fetch_live_weather(lat, lng)
    risk_data = get_weather_risk_level(weather_data)
    
    return {
        'current': {
            'temperature_avg': weather_data.get('temperature_avg', 25),
            'humidity_avg': weather_data.get('humidity_avg', 65),
            'rainfall_mm': weather_data.get('rainfall_mm', 0),
            'wind_speed': weather_data.get('wind_speed', 10),
            'leaf_wetness_hours': weather_data.get('leaf_wetness_hours', 0),
            'forecast_3d_rain': weather_data.get('forecast_3d_rain', 0)
        },
        'risk': risk_data,
        'is_fallback': weather_data.get('is_fallback', False),
        'source': weather_data.get('source', 'unknown')
    }