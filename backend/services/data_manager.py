"""
Data Manager for Crop Disease Intelligence Platform
Handles all data loading, caching, and lookup operations for:
- Inventory management
- Sales/POS data
- Grower/retailer information  
- Pest/disease risk assessment
- Weather data integration
"""

import os
import csv
import json
import logging
import hashlib
from datetime import timedelta
from typing import Dict, List, Optional, Tuple, Any

import pandas as pd

# Configure module logger
logger = logging.getLogger(__name__)

# ============================================================================
# CONSTANTS AND CONFIGURATION
# ============================================================================

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'Data'))
DATA_LOADED = False
LATEST_DATA_DATE: Optional[str] = None

# Default fallback date when no data available
DEFAULT_LATEST_DATE = '2026-03-21'

# DataFrames for loaded data
latest_inventory = pd.DataFrame()
pos = pd.DataFrame()
growers = pd.DataFrame()
retailers = pd.DataFrame()
visit_logs = pd.DataFrame()
whatsapp = pd.DataFrame()
weather_csv = pd.DataFrame()
pest_csv = pd.DataFrame()
disease_map = pd.DataFrame()
fungicide_kb = pd.DataFrame()
crop_prices = pd.DataFrame()
geo_coords = pd.DataFrame()

# Lookup dictionaries for fast access
pest_lookup: Dict = {}
vuln_lookup: Dict = {}
fung_lookup: Dict = {}
weather_lookup: Dict = {}
price_lookup: Dict = {}
rep_territory: Dict[str, List[str]] = {}  # Changed to list of territories
ALL_REPS: List[str] = []

# Fallback coordinates for districts without geo data
DISTRICT_COORDS = {
    'Kanpur Nagar': (26.4499, 80.3319),
    'Bharatpur': (27.2211, 77.4949),
    'Patiala': (30.3398, 76.3869),
    'Karnal': (29.6857, 76.9905),
    'Patna': (25.5941, 85.1376)
}


# ============================================================================
# HELPER FUNCTIONS
# ============================================================================

def load_csv_safe(filename: str, usecols: Optional[List[str]] = None) -> pd.DataFrame:
    """
    Safely load a CSV file, returning empty DataFrame if file not found.
    
    Args:
        filename: Name of CSV file in DATA directory
        usecols: Optional list of column names to load
        
    Returns:
        DataFrame with loaded data or empty DataFrame
    """
    filepath = os.path.join(DATA, filename)
    try:
        df = pd.read_csv(filepath, usecols=usecols)
        logger.debug(f"Loaded {filename}: {len(df)} rows")
        return df
    except FileNotFoundError:
        logger.warning(f"File not found: {filepath}")
        return pd.DataFrame()
    except Exception as e:
        logger.error(f"Error loading {filename}: {e}")
        return pd.DataFrame()


def parse_date_safely(date_str: str, date_format: str = '%Y-%m-%d') -> Optional[pd.Timestamp]:
    """
    Safely parse date string with error handling.
    
    Args:
        date_str: Date string to parse
        date_format: Expected date format
        
    Returns:
        Timestamp or None if parsing fails
    """
    try:
        return pd.to_datetime(date_str, format=date_format)
    except (ValueError, TypeError):
        try:
            return pd.to_datetime(date_str)
        except:
            logger.warning(f"Failed to parse date: {date_str}")
            return None


# ============================================================================
# MAIN DATA LOADING FUNCTION
# ============================================================================

def load_data() -> None:
    """
    Load all datasets from CSV files into global DataFrames and lookup dictionaries.
    
    This function:
    1. Streams large inventory file to get only latest week's data
    2. Filters POS data to last 60 days
    3. Loads other datasets with memory optimization
    4. Builds lookup dictionaries for fast querying
    """
    global latest_inventory, pos, growers, retailers, visit_logs, whatsapp
    global weather_csv, pest_csv, disease_map, fungicide_kb, crop_prices, geo_coords
    global pest_lookup, vuln_lookup, fung_lookup, weather_lookup, price_lookup
    global rep_territory, ALL_REPS, LATEST_DATA_DATE

    logger.info("=" * 60)
    logger.info("Starting data load from: %s", DATA)
    logger.info("=" * 60)

    # ------------------------------------------------------------------------
    # 1. Load Inventory Data (Streamed for memory efficiency)
    # ------------------------------------------------------------------------
    inv_rows = []
    latest_inv_date = ""
    inventory_file = os.path.join(DATA, 'retailer_inventory_weekly.csv')
    
    try:
        with open(inventory_file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                row_date = row.get('week_end_date', '')
                if row_date > latest_inv_date:
                    latest_inv_date = row_date
                    inv_rows = [row]
                elif row_date == latest_inv_date:
                    inv_rows.append(row)
        logger.info(f"Inventory: Loaded {len(inv_rows)} records for week ending {latest_inv_date}")
    except FileNotFoundError:
        logger.warning(f"Inventory file not found: {inventory_file}")
    except Exception as e:
        logger.error(f"Error loading inventory: {e}")

    latest_inventory = pd.DataFrame(inv_rows)
    if not latest_inventory.empty:
        latest_inventory['sku_qty'] = pd.to_numeric(latest_inventory['sku_qty'], errors='coerce')

    # Set latest data date - prioritize inventory date
    if latest_inv_date:
        LATEST_DATA_DATE = latest_inv_date
    else:
        LATEST_DATA_DATE = DEFAULT_LATEST_DATE
        logger.info(f"No inventory date found, using default: {LATEST_DATA_DATE}")

    # ------------------------------------------------------------------------
    # 2. Load POS Data (Filtered to last 60 days)
    # ------------------------------------------------------------------------
    pos_cutoff = (pd.Timestamp(LATEST_DATA_DATE) - timedelta(days=60)).strftime('%Y-%m-%d')
    pos_rows = []
    pos_file = os.path.join(DATA, 'retailer_pos.csv')
    
    try:
        with open(pos_file, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row.get('transaction_date', '') >= pos_cutoff:
                    pos_rows.append(row)
        logger.info(f"POS: Loaded {len(pos_rows)} transactions since {pos_cutoff}")
    except FileNotFoundError:
        logger.warning(f"POS file not found: {pos_file}")
    except Exception as e:
        logger.error(f"Error loading POS data: {e}")

    pos = pd.DataFrame(pos_rows)
    if not pos.empty:
        pos['transaction_date'] = pd.to_datetime(pos['transaction_date'], errors='coerce')

    # ------------------------------------------------------------------------
    # 3. Load Remaining Datasets
    # ------------------------------------------------------------------------
    logger.info("Loading remaining datasets...")
    
    growers = load_csv_safe('growers.csv')
    retailers = load_csv_safe('retailers.csv')
    
    visit_logs = load_csv_safe('retailer_visit_log.csv', usecols=['rep_id', 'visit_date', 'territory_id', 'visit_tehsil'])
    if not visit_logs.empty:
        visit_logs['visit_date'] = pd.to_datetime(visit_logs['visit_date'], errors='coerce')
        # Update LATEST_DATA_DATE from most recent visit
        latest_visit = visit_logs['visit_date'].max()
        if pd.notna(latest_visit):
            visit_date_str = latest_visit.strftime('%Y-%m-%d')
            if LATEST_DATA_DATE < visit_date_str:
                LATEST_DATA_DATE = visit_date_str
                logger.info(f"Updated data date from visits: {LATEST_DATA_DATE}")

    whatsapp = load_csv_safe('whatsapp_campaign.csv', usecols=['grower_id', 'message_sent_date', 'delivered_status', 'opened_status', 'clicked_status'])
    if not whatsapp.empty:
        whatsapp['message_sent_date'] = pd.to_datetime(whatsapp['message_sent_date'], errors='coerce')

    weather_csv = load_csv_safe('weather_tehsil_daily.csv')
    pest_csv = load_csv_safe('pest_outbreak_risk.csv')
    disease_map = load_csv_safe('crop_disease_stage_mapping.csv')
    fungicide_kb = load_csv_safe('fungicide_knowledge_base.csv')
    crop_prices = load_csv_safe('crop_price_market.csv')
    geo_coords = load_csv_safe('tehsil_geo_coordinates.csv')

    logger.info(f"All datasets loaded. Latest data date: {LATEST_DATA_DATE}")

    # ------------------------------------------------------------------------
    # 4. Build Lookup Dictionaries
    # ------------------------------------------------------------------------
    _build_pest_lookup()
    _build_vulnerability_lookup()
    _build_fungicide_lookup()
    _build_weather_lookup()
    _build_price_lookup()
    _build_rep_lookups()


def _build_pest_lookup() -> None:
    """Build pest risk lookup dictionary by district and crop."""
    global pest_lookup
    pest_lookup = {}
    
    if pest_csv.empty:
        logger.warning("Pest CSV empty, pest lookup will be unavailable")
        return
    
    for _, row in pest_csv.iterrows():
        district = row.get('district')
        crop = row.get('crop')
        if not district or not crop:
            continue
            
        if district not in pest_lookup:
            pest_lookup[district] = {}
        
        pest_lookup[district][crop] = {
            'disease': row.get('disease_name', 'unknown'),
            'probability': float(row.get('outbreak_probability', 0)),
            'severity': row.get('risk_level', 'low'),
            'trend': row.get('severity_trend', 'stable'),
            'product': row.get('recommended_product', ''),
            'last_updated': row.get('date', LATEST_DATA_DATE)
        }
    
    logger.info(f"Pest lookup built for {len(pest_lookup)} districts")


def _build_vulnerability_lookup() -> None:
    """Build crop stage vulnerability lookup."""
    global vuln_lookup
    vuln_lookup = {}
    
    if disease_map.empty:
        logger.warning("Disease map empty, vulnerability lookup will be unavailable")
        return
    
    for _, row in disease_map.iterrows():
        crop = str(row.get('crop', '')).lower()
        stage = str(row.get('stage', '')).lower()
        key = (crop, stage)
        
        vuln_score = float(row.get('vulnerability_score', 0))
        
        # Keep the highest vulnerability score for each (crop, stage) pair
        if key not in vuln_lookup or vuln_score > vuln_lookup[key]['vuln']:
            vuln_lookup[key] = {
                'vuln': vuln_score,
                'disease': row.get('disease', 'unknown'),
                'product': row.get('product_recommended', ''),
                'days_critical': int(row.get('days_to_critical', 30)),
                'description': row.get('disease_description', '')
            }
    
    logger.info(f"Vulnerability lookup built for {len(vuln_lookup)} crop-stage combinations")


def _build_fungicide_lookup() -> None:
    """Build fungicide recommendation lookup by disease."""
    global fung_lookup
    fung_lookup = {}
    
    if fungicide_kb.empty:
        logger.warning("Fungicide KB empty, recommendations will be unavailable")
        return
    
    for _, row in fungicide_kb.iterrows():
        disease = row.get('disease')
        if not disease:
            continue
            
        if disease not in fung_lookup:
            fung_lookup[disease] = []
        
        fung_lookup[disease].append({
            'product': row.get('recommended_product', ''),
            'dosage': row.get('dosage', ''),
            'urgency': row.get('urgency', 'medium'),
            'window_days': int(row.get('treatment_window_days', 7)),
            'cost': float(row.get('cost_per_acre', 0)),
            'efficacy': float(row.get('efficacy_rating', 0)),
            'application_method': row.get('application_method', '')
        })
    
    # Sort by efficacy descending for each disease
    for disease in fung_lookup:
        fung_lookup[disease].sort(key=lambda x: x['efficacy'], reverse=True)
    
    logger.info(f"Fungicide lookup built for {len(fung_lookup)} diseases")


def _build_weather_lookup() -> None:
    """Build weather data lookup by district."""
    global weather_lookup
    weather_lookup = {}
    
    if weather_csv.empty:
        logger.warning("Weather CSV empty, weather lookup will be unavailable")
        return
    
    # Group by district and get most recent data
    weather_csv['date'] = pd.to_datetime(weather_csv.get('date', LATEST_DATA_DATE), errors='coerce')
    latest_weather = weather_csv.sort_values('date', ascending=False).drop_duplicates('district')
    
    for _, row in latest_weather.iterrows():
        district = row.get('district')
        if district:
            weather_lookup[district] = row.to_dict()
    
    logger.info(f"Weather lookup built for {len(weather_lookup)} districts")


def _build_price_lookup() -> None:
    """Build crop price lookup with latest market prices."""
    global price_lookup
    price_lookup = {}
    
    if crop_prices.empty:
        logger.warning("Crop prices empty, price lookup will be unavailable")
        return
    
    # Get latest prices per crop
    crop_prices['week_end_date'] = pd.to_datetime(crop_prices.get('week_end_date', LATEST_DATA_DATE), errors='coerce')
    latest_prices = crop_prices.sort_values('week_end_date', ascending=False).drop_duplicates('crop')
    
    for _, row in latest_prices.iterrows():
        crop = str(row.get('crop', '')).lower()
        price_lookup[crop] = {
            'price': float(row.get('mandi_price', 0)),
            'change': float(row.get('weekly_change_percent', 0)),
            'trend': row.get('price_trend', 'stable'),
            'market': row.get('market_name', ''),
            'date': row.get('week_end_date', LATEST_DATA_DATE)
        }
    
    logger.info(f"Price lookup built for {len(price_lookup)} crops")


def _build_rep_lookups() -> None:
    """Build representative territory and tehsil lookups."""
    global rep_territory, ALL_REPS
    
    rep_territory = {}
    
    if not visit_logs.empty:
        # Group territories by rep (handle multiple territories per rep)
        for rep_id, group in visit_logs.groupby('rep_id'):
            territories = group['territory_id'].dropna().unique().tolist()
            if territories:
                rep_territory[rep_id] = territories
        
        ALL_REPS = sorted(visit_logs['rep_id'].dropna().unique().tolist())
        logger.info(f"Rep lookups built for {len(ALL_REPS)} representatives")
    else:
        ALL_REPS = []
        logger.warning("No visit logs found, rep lookups will be empty")


def ensure_data_loaded() -> None:
    """Ensure data is loaded (idempotent check)."""
    global DATA_LOADED
    if not DATA_LOADED:
        load_data()
        DATA_LOADED = True
        logger.info("Data load completed successfully")
    else:
        logger.debug("Data already loaded, skipping")


# ============================================================================
# PUBLIC QUERY FUNCTIONS
# ============================================================================

def get_rep_tehsils(rep_id: str) -> List[str]:
    """
    Get all tehsils associated with a representative.
    
    Args:
        rep_id: Representative ID
        
    Returns:
        List of tehsil names
    """
    ensure_data_loaded()
    
    if visit_logs.empty:
        return []
    
    # Get tehsils from visit logs
    tehsils = set()
    rep_visits = visit_logs[visit_logs['rep_id'] == rep_id]
    if not rep_visits.empty:
        tehsils.update(rep_visits['visit_tehsil'].dropna().unique())
    
    # Add tehsils from retailers in rep's territory
    territories = rep_territory.get(rep_id, [])
    if territories and not retailers.empty:
        for territory in territories:
            ter_retailers = retailers[retailers['territory_id'] == territory]
            tehsils.update(ter_retailers['tehsil'].dropna().unique())
    
    return list(tehsils)


def get_rep_info(rep_id: str) -> Tuple[str, str]:
    """
    Get state and district for a representative.
    
    Args:
        rep_id: Representative ID
        
    Returns:
        Tuple of (state, district)
    """
    ensure_data_loaded()
    
    territories = rep_territory.get(rep_id, [])
    if territories and not retailers.empty:
        ter_retailers = retailers[retailers['territory_id'].isin(territories)]
        if not ter_retailers.empty:
            first = ter_retailers.iloc[0]
            return str(first.get('state', 'Unknown')), str(first.get('district', 'Unknown'))
    
    return "Unknown", "Unknown"


def get_fallback_coords(district: str, tehsil_str: str) -> Tuple[float, float]:
    """
    Generate deterministic fallback coordinates for a tehsil.
    
    Args:
        district: District name
        tehsil_str: Tehsil name for hash-based offset
        
    Returns:
        Tuple of (latitude, longitude)
    """
    base_lat, base_lng = DISTRICT_COORDS.get(district, (22.0, 78.0))
    
    # Use hash of tehsil name for deterministic offset
    h = int(hashlib.md5(tehsil_str.encode()).hexdigest(), 16)
    lat_offset = ((h % 100) - 50) / 100.0 * 0.4
    lng_offset = (((h // 100) % 100) - 50) / 100.0 * 0.4
    
    return round(base_lat + lat_offset, 4), round(base_lng + lng_offset, 4)


def parse_crop_stage(cal_str: str, target_date) -> Tuple[str, str, int, List]:
    """
    Parse crop calendar JSON to determine current growth stage.
    
    Args:
        cal_str: JSON string containing crop calendar data
        target_date: Date to evaluate (Timestamp or date string)
        
    Returns:
        Tuple of (crop_name, stage_name, days_to_stage, stages_list)
    """
    ensure_data_loaded()
    
    default_result = ('wheat', 'unknown', 30, [])
    
    if not cal_str or pd.isna(cal_str):
        logger.debug("Empty crop calendar string")
        return default_result
    
    try:
        cal = json.loads(cal_str)
        crop = cal.get('crop', 'unknown').lower()
        stages = cal.get('stages', [])
        
        if not stages:
            logger.debug(f"No stages found for crop {crop}")
            return crop, 'vegetative', 30, []
        
        # Convert target_date to date object for comparison
        if hasattr(target_date, 'date'):
            target_date = target_date.date()
        elif isinstance(target_date, str):
            target_date = pd.Timestamp(target_date).date()
        
        # Find closest stage
        best_stage = stages[0]['stage']
        min_abs_days = float('inf')
        days_to = 30
        
        for stage in stages:
            stage_date = pd.Timestamp(stage['approx']).date()
            delta = (stage_date - target_date).days
            
            if abs(delta) < min_abs_days:
                min_abs_days = abs(delta)
                best_stage = stage['stage']
                days_to = delta
        
        logger.debug(f"Parsed crop stage: {crop} @ {best_stage} (days: {days_to})")
        return crop, best_stage.lower(), days_to, stages
        
    except json.JSONDecodeError as e:
        logger.warning(f"Invalid JSON in crop calendar: {e}")
    except Exception as e:
        logger.error(f"Unexpected error parsing crop stage: {e}")
    
    return default_result


# ============================================================================
# ADDITIONAL HELPER FUNCTIONS FOR UI
# ============================================================================

def get_pest_risk(district: str, crop: str) -> Optional[Dict]:
    """
    Get pest risk assessment for a district-crop combination.
    
    Args:
        district: District name
        crop: Crop name
        
    Returns:
        Dictionary with risk data or None if not found
    """
    ensure_data_loaded()
    
    district_data = pest_lookup.get(district, {})
    return district_data.get(crop.lower())


def get_vulnerability(crop: str, stage: str) -> Optional[Dict]:
    """
    Get vulnerability score for crop at specific growth stage.
    
    Args:
        crop: Crop name
        stage: Growth stage name
        
    Returns:
        Dictionary with vulnerability data or None
    """
    ensure_data_loaded()
    
    key = (crop.lower(), stage.lower())
    return vuln_lookup.get(key)


def get_fungicide_recommendations(disease: str) -> List[Dict]:
    """
    Get fungicide recommendations for a disease.
    
    Args:
        disease: Disease name
        
    Returns:
        List of recommendation dictionaries (sorted by efficacy)
    """
    ensure_data_loaded()
    
    return fung_lookup.get(disease, [])


def get_crop_price(crop: str) -> Optional[Dict]:
    """
    Get current market price for a crop.
    
    Args:
        crop: Crop name
        
    Returns:
        Dictionary with price data or None
    """
    ensure_data_loaded()
    
    return price_lookup.get(crop.lower())


def get_weather(district: str) -> Optional[Dict]:
    """
    Get current weather data for a district.
    
    Args:
        district: District name
        
    Returns:
        Dictionary with weather data or None
    """
    ensure_data_loaded()
    
    return weather_lookup.get(district)


def get_data_summary() -> Dict[str, Any]:
    """
    Get summary statistics of loaded data for dashboard display.
    
    Returns:
        Dictionary with data counts and latest dates
    """
    ensure_data_loaded()
    
    return {
        'latest_data_date': LATEST_DATA_DATE,
        'inventory_records': len(latest_inventory),
        'pos_records': len(pos),
        'growers_count': len(growers),
        'retailers_count': len(retailers),
        'visits_count': len(visit_logs),
        'districts_covered': len(weather_lookup),
        'crops_tracked': len(price_lookup),
        'reps_count': len(ALL_REPS)
    }