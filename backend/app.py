import os
import math
import time
import pandas as pd
from datetime import datetime
from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

from backend.services.threat_engine import (
    compute_tehsil_threat, simulate_inaction, compute_weather_risk,
    get_weather_interpretation, optimize_route, learn_ml_weights,
    post_process_threats, PEST_BOOST
)
import backend.services.data_manager as dm

app = Flask(
    __name__,
    template_folder=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'templates'),
    static_folder=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'static')
)
CORS(app)

@app.before_request
def init_data():
    dm.ensure_data_loaded()

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/init')
def init():
    dm.ensure_data_loaded()
    districts = []
    if not dm.retailers.empty:
        districts = sorted(dm.retailers['district'].dropna().unique().tolist())
    if not districts and dm.pest_lookup:
        districts = sorted(list(dm.pest_lookup.keys()))
    return jsonify({
        'status': 'ready',
        'reps': dm.ALL_REPS,
        'total_growers': len(dm.growers),
        'districts': districts,
        'latest_data_date': dm.LATEST_DATA_DATE
    })

@app.route('/api/warmup')
def warmup():
    dm.ensure_data_loaded()
    return jsonify({'status': 'ready', 'message': 'Warmup complete', 'reps': dm.ALL_REPS})

@app.route('/api/dashboard/<rep_id>')
def dashboard(rep_id):
    sim_date_str = request.args.get('date', dm.LATEST_DATA_DATE)
    try:
        target_date = pd.Timestamp(sim_date_str).date()
    except:
        target_date = pd.Timestamp(dm.LATEST_DATA_DATE).date()

    state, district = dm.get_rep_info(rep_id)
    tehsils = dm.get_rep_tehsils(rep_id)

    threats = []
    for t in tehsils:
        t_ret = dm.retailers[dm.retailers['tehsil'] == t] if not dm.retailers.empty else pd.DataFrame()
        t_district = t_ret.iloc[0]['district'] if len(t_ret) > 0 else district
        threat = compute_tehsil_threat(t, t_district, target_date)
        if threat:
            threats.append(threat)

    threats = post_process_threats(threats)

    route_result = optimize_route(threats)
    route_stops, monitoring_only = route_result

    # Cost of inaction from highest-scoring tehsil (Bug 2)
    consequence = simulate_inaction(threats[0]) if threats else None

    total_critical = sum(1 for t in threats if t['threat_level'] == 'CRITICAL')
    total_high = sum(1 for t in threats if t['threat_level'] == 'HIGH')
    total_medium = sum(1 for t in threats if t['threat_level'] == 'MEDIUM')
    total_revenue_risk = sum(t['revenue_at_risk'] for t in threats)
    total_stockouts = sum(t['stockouts'] for t in threats)

    _, weather_detail = compute_weather_risk(district)
    weather_interp = get_weather_interpretation(weather_detail)

    market = {}
    for crop_name, pdata in dm.price_lookup.items():
        fluct = math.sin(time.time() / 1800) * 0.03
        market[crop_name] = {
            'price': round(pdata['price'] * (1 + fluct)),
            'change': round(pdata['change'] + fluct * 100, 2),
            'trend': pdata['trend']
        }

    # Campaign stats with open_rate and click_rate (Bug 4)
    rep_grower_ids = dm.growers[dm.growers['tehsil'].isin(tehsils)]['grower_id'].tolist() if not dm.growers.empty else []
    rep_campaigns = dm.whatsapp[dm.whatsapp['grower_id'].isin(rep_grower_ids)] if not dm.whatsapp.empty else pd.DataFrame()
    sent = len(rep_campaigns)
    delivered = int(rep_campaigns['delivered_status'].sum()) if not rep_campaigns.empty else 0
    opened = int(rep_campaigns['opened_status'].sum()) if not rep_campaigns.empty else 0
    clicked = int(rep_campaigns['clicked_status'].sum()) if not rep_campaigns.empty else 0
    campaign_stats = {
        'sent': sent, 'delivered': delivered, 'opened': opened, 'clicked': clicked,
        'open_rate': round(opened / max(delivered, 1) * 100, 1),
        'click_rate': round(clicked / max(opened, 1) * 100, 1),
        'cvr': round(clicked / max(delivered, 1) * 100, 1),
    }

    # District-level disease context (Bug 8)
    district_diseases = []
    for crop, info in dm.pest_lookup.get(district, {}).items():
        district_diseases.append({
            'crop': crop, 'disease': info.get('disease', ''),
            'risk_level': info.get('severity', 'LOW'),
            'probability': info.get('probability', 0)
        })

    rep_lat, rep_lng = dm.get_fallback_coords(district, district)

    return jsonify({
        'rep_id': rep_id, 'state': state, 'district': district,
        'lat': rep_lat, 'lng': rep_lng, 'tehsils': tehsils,
        'last_updated': datetime.now().isoformat(),
        'stats': {
            'critical': total_critical, 'high': total_high, 'medium': total_medium,
            'revenue_risk': total_revenue_risk, 'stockouts': total_stockouts
        },
        'threats': threats, 'route': route_stops, 'monitoring_only': monitoring_only,
        'consequence': consequence,
        'weather': weather_detail, 'weather_interpretation': weather_interp,
        'market': market, 'campaign': campaign_stats,
        'district_diseases': district_diseases
    })

@app.route('/api/ml-weights')
def ml_weights():
    weights = learn_ml_weights()
    return jsonify({
        'status': 'success', 'weights': weights,
        'defaults': {'bio_window': 0.35, 'inv_pressure': 0.25, 'dig_warmth': 0.20, 'visit_recency': 0.15, 'pos_momentum': 0.05},
        'note': 'Trained on available historical data. Actual importances will calibrate with real outcomes.'
    })

@app.route('/api/simulate-pest', methods=['POST'])
def simulate_pest():
    data = request.get_json() or {}
    district = data.get('district')
    reset = data.get('reset', False)
    if reset:
        PEST_BOOST["district"] = None
        PEST_BOOST["boost"] = 0.0
        return jsonify({'status': 'success', 'message': 'Pest outbreak boost deactivated.'})
    if district:
        PEST_BOOST["district"] = district
        PEST_BOOST["boost"] = 0.40
        return jsonify({
            'status': 'success',
            'message': f'CRITICAL: Pest bulletin for {district}! Pest probability +40%.',
            'district': district, 'boost': 0.40
        })
    return jsonify({'status': 'error', 'message': 'District required.'}), 400

@app.route('/api/export')
def export_priorities():
    rep_id = request.args.get('rep_id')
    sim_date_str = request.args.get('date', dm.LATEST_DATA_DATE)
    if not rep_id:
        return jsonify({'status': 'error', 'message': 'Rep ID required.'}), 400
    try:
        target_date = pd.Timestamp(sim_date_str).date()
    except:
        target_date = pd.Timestamp(dm.LATEST_DATA_DATE).date()

    state, district = dm.get_rep_info(rep_id)
    tehsils = dm.get_rep_tehsils(rep_id)
    rows = []
    for t in tehsils:
        t_ret = dm.retailers[dm.retailers['tehsil'] == t] if not dm.retailers.empty else pd.DataFrame()
        t_district = t_ret.iloc[0]['district'] if len(t_ret) > 0 else district
        threat = compute_tehsil_threat(t, t_district, target_date)
        if threat:
            rows.append({
                'Tehsil': threat['tehsil'], 'Score': threat['heat_score'],
                'Level': threat['threat_level'], 'Crop': threat['dominant_crop'],
                'Stage': threat['dominant_stage'], 'Bio Score': threat['bio_score'],
                'Inventory Risk': threat['inv_risk'], 'Digital': threat['digital_risk'],
                'Visit Recency': threat['visit_risk'], 'POS Momentum': threat['pos_spike_score'],
                'Revenue at Risk': f"INR {threat['revenue_at_risk']}",
                'Explanation': threat['explanation']
            })
    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values('Score', ascending=False)
    csv_data = df.to_csv(index=False)
    return app.response_class(
        response=csv_data, status=200, mimetype='text/csv',
        headers={"Content-disposition": f"attachment; filename=KRITECH_{rep_id}_{sim_date_str}.csv"}
    )

if __name__ == '__main__':
    print("KRITECH Dynamic Prioritization Engine — http://127.0.0.1:5000")
    app.run(port=5000, debug=False, use_reloader=False)
