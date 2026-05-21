import os
import requests

def fetch_live_weather(lat, lng):
    """Fetch 100% REAL live weather from Open-Meteo"""
    try:
        url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lng}&current=temperature_2m,relative_humidity_2m,precipitation&daily=precipitation_sum&timezone=auto"
        r = requests.get(url, timeout=3).json()
        return {
            'temperature_avg': r['current']['temperature_2m'],
            'humidity_avg': r['current']['relative_humidity_2m'],
            'rainfall_mm': r['current']['precipitation'],
            'forecast_3d_rain': sum(r['daily']['precipitation_sum'][:3])
        }
    except:
        return None
