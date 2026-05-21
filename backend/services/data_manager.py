import os
import csv
import json
import pandas as pd
from datetime import timedelta

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'Data'))
DATA_LOADED = False

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

pest_lookup = {}
vuln_lookup = {}
fung_lookup = {}
weather_lookup = {}
price_lookup = {}
rep_territory = {}
ALL_REPS = []


def load_csv_safe(filename, usecols=None):
    try:
        return pd.read_csv(os.path.join(DATA, filename), usecols=usecols)
    except FileNotFoundError:
        return pd.DataFrame()


def load_data():
    global latest_inventory, pos, growers, retailers, visit_logs, whatsapp
    global weather_csv, pest_csv, disease_map, fungicide_kb, crop_prices, geo_coords
    global pest_lookup, vuln_lookup, fung_lookup, weather_lookup, price_lookup
    global rep_territory, ALL_REPS

    print("Loading large datasets via streaming...")

    inv_rows = []
    latest_inv_date = ""
    try:
        with open(os.path.join(DATA, 'retailer_inventory_weekly.csv'), 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row['week_end_date'] > latest_inv_date:
                    latest_inv_date = row['week_end_date']
                    inv_rows = [row]
                elif row['week_end_date'] == latest_inv_date:
                    inv_rows.append(row)
    except FileNotFoundError:
        pass

    latest_inventory = pd.DataFrame(inv_rows)
    if not latest_inventory.empty:
        latest_inventory['sku_qty'] = pd.to_numeric(latest_inventory['sku_qty'])

    pos_cutoff = (pd.Timestamp('2026-03-18') - timedelta(days=30)).strftime('%Y-%m-%d')
    pos_rows = []
    try:
        with open(os.path.join(DATA, 'retailer_pos.csv'), 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                if row['transaction_date'] >= pos_cutoff:
                    pos_rows.append(row)
    except FileNotFoundError:
        pass

    pos = pd.DataFrame(pos_rows)
    if not pos.empty:
        pos['transaction_date'] = pd.to_datetime(pos['transaction_date'])

    print("Loading remaining datasets...")
    growers = load_csv_safe('growers.csv')
    retailers = load_csv_safe('retailers.csv')
    visit_logs = load_csv_safe('retailer_visit_log.csv', usecols=['rep_id', 'visit_date', 'territory_id', 'visit_tehsil'])
    if not visit_logs.empty:
        visit_logs['visit_date'] = pd.to_datetime(visit_logs['visit_date'])

    whatsapp = load_csv_safe('whatsapp_campaign.csv', usecols=['grower_id', 'message_sent_date', 'delivered_status', 'opened_status', 'clicked_status'])
    if not whatsapp.empty:
        whatsapp['message_sent_date'] = pd.to_datetime(whatsapp['message_sent_date'])

    weather_csv = load_csv_safe('weather_tehsil_daily.csv')
    pest_csv = load_csv_safe('pest_outbreak_risk.csv')
    disease_map = load_csv_safe('crop_disease_stage_mapping.csv')
    fungicide_kb = load_csv_safe('fungicide_knowledge_base.csv')
    crop_prices = load_csv_safe('crop_price_market.csv')
    geo_coords = load_csv_safe('tehsil_geo_coordinates.csv')

    pest_lookup = {}
    if not pest_csv.empty:
        for _, r in pest_csv.iterrows():
            d = r['district']
            if d not in pest_lookup:
                pest_lookup[d] = {}
            pest_lookup[d][r['crop']] = {
                'disease': r['disease_name'],
                'probability': float(r['outbreak_probability']),
                'severity': r['risk_level'],
                'trend': r.get('severity_trend', 'stable'),
                'product': r.get('recommended_product', '')
            }

    vuln_lookup = {}
    if not disease_map.empty:
        for _, r in disease_map.iterrows():
            key = (r['crop'].lower(), r['stage'].lower())
            if key not in vuln_lookup or r['vulnerability_score'] > vuln_lookup[key]['vuln']:
                vuln_lookup[key] = {
                    'vuln': float(r['vulnerability_score']),
                    'disease': r['disease'],
                    'product': r['product_recommended'],
                    'days_critical': int(r['days_to_critical'])
                }

    fung_lookup = {}
    if not fungicide_kb.empty:
        for _, r in fungicide_kb.iterrows():
            d = r['disease']
            if d not in fung_lookup:
                fung_lookup[d] = []
            fung_lookup[d].append({
                'product': r['recommended_product'],
                'dosage': r['dosage'],
                'urgency': r['urgency'],
                'window_days': int(r['treatment_window_days']),
                'cost': float(r['cost_per_acre']),
                'efficacy': float(r['efficacy_rating'])
            })

    weather_lookup = {}
    if not weather_csv.empty:
        for _, r in weather_csv.iterrows():
            weather_lookup[r['district']] = r.to_dict()

    price_lookup = {}
    if not crop_prices.empty:
        latest_prices = crop_prices.sort_values('week_end_date', ascending=False).drop_duplicates('crop')
        for _, r in latest_prices.iterrows():
            price_lookup[r['crop'].lower()] = {
                'price': float(r['mandi_price']),
                'change': float(r['weekly_change_percent']),
                'trend': r['price_trend']
            }

    rep_territory = dict(zip(visit_logs['rep_id'], visit_logs['territory_id'])) if not visit_logs.empty else {}
    ALL_REPS = sorted(visit_logs['rep_id'].unique().tolist()) if not visit_logs.empty else []


def ensure_data_loaded():
    global DATA_LOADED
    if not DATA_LOADED:
        load_data()
        DATA_LOADED = True

DISTRICT_COORDS = {
    'Kanpur Nagar': (26.4499, 80.3319),
    'Bharatpur': (27.2211, 77.4949),
    'Patiala': (30.3398, 76.3869),
    'Karnal': (29.6857, 76.9905),
    'Patna': (25.5941, 85.1376)
}

def get_fallback_coords(district, tehsil_str):
    import hashlib
    h = int(hashlib.md5(tehsil_str.encode()).hexdigest(), 16)
    base_lat, base_lng = DISTRICT_COORDS.get(district, (22.0, 78.0))
    lat_offset = ((h % 100) - 50) / 100.0 * 0.4 
    lng_offset = (((h // 100) % 100) - 50) / 100.0 * 0.4
    return round(base_lat + lat_offset, 4), round(base_lng + lng_offset, 4)

def get_rep_tehsils(rep_id):
    if visit_logs.empty: return []
    ter_id = rep_territory.get(rep_id)
    tehsils = set(visit_logs[visit_logs['rep_id'] == rep_id]['visit_tehsil'].unique())
    if ter_id and not retailers.empty:
        tehsils |= set(retailers[retailers['territory_id'] == ter_id]['tehsil'].unique())
    return list(tehsils)

def get_rep_info(rep_id):
    ter_id = rep_territory.get(rep_id)
    if ter_id and not retailers.empty:
        r = retailers[retailers['territory_id'] == ter_id]
        if len(r) > 0:
            return r.iloc[0]['state'], r.iloc[0]['district']
    return "Unknown", "Unknown"

def parse_crop_stage(cal_str, target_date):
    try:
        cal = json.loads(cal_str)
        crop = cal.get('crop', 'unknown').lower()
        stages = cal.get('stages', [])
        if not stages:
            return crop, 'vegetative', 30, []
        
        best_stage = stages[0]['stage']
        min_abs_days = float('inf')
        days_to = 30
        
        for s in stages:
            sd = pd.Timestamp(s['approx']).date()
            delta = (sd - target_date).days
            if abs(delta) < min_abs_days:
                min_abs_days = abs(delta)
                best_stage = s['stage']
                days_to = delta
        
        return crop, best_stage.lower(), days_to, stages
    except:
        return 'wheat', 'unknown', 30, []
