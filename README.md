# AgriPulse BioRisk Engine

AgriPulse is an advanced predictive intelligence platform designed for field force operations. It transitions traditional prioritization tools into a high-performance system by integrating live weather data, biological threat calculations, inventory risk, and geospatial intelligence.

## Features

- **Biological Threat Window**: Real-time biological threat calculations based on crop stage vulnerability, pest probabilities, and live weather conditions.
- **Live Weather Integration**: Connects with Open-Meteo API to fetch 100% live weather data (temperature, humidity, precipitation) for highly accurate risk modeling.
- **Inventory Pressure Tracking**: Monitors SKU stockouts and low stock levels to dynamically rank urgency.
- **Geospatial Prioritization**: Generates interactive threat heatmaps for sales representatives.
- **Digital Warm Leads**: Integrates WhatsApp campaign metrics to identify growers who opened advisories.
- **Silent Outbreak Detection**: Identifies sudden spikes in fungicide POS transactions indicative of an outbreak.

## Project Structure

```text
├── backend/                  # Flask Backend Application
│   ├── app.py                # Main application entry point & routes
│   └── services/             # Modularized backend services
│       ├── data_manager.py   # Handles data ingestion and lookups
│       ├── threat_engine.py  # Core algorithms for risk/threat computation
│       └── weather_service.py# Live weather API integrations
├── frontend/                 # Frontend Assets
│   ├── static/               # CSS, JS, Images (Teal-to-Lavender Glassmorphism)
│   └── templates/            # Jinja2 HTML templates
├── data/                     # CSV Datasets
├── run.py                    # Server startup script
├── requirements.txt          # Python dependencies
└── README.md                 # Project Documentation
```

## Quick Start

### 1. Install Dependencies
```bash
pip install -r requirements.txt
```

### 2. Run the Server
```bash
python run.py
```
*The server will start at `http://127.0.0.1:5000`*

### 3. Access the Dashboard
Navigate to `http://127.0.0.1:5000` in your web browser.

## Architecture Highlights
- **Streaming Data Loaders**: Optimized memory usage via line-by-line CSV streaming for massive datasets.
- **Modular Services**: Decoupled weather, data management, and risk engine logic for maintainability.
- **Professional UI/UX**: Stunning UI with modern web design principles—utilizing rich aesthetics, dynamic gradients, and smooth micro-animations.

---
*Built for precision agriculture and field force intelligence.*
