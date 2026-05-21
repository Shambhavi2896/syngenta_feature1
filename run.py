import os
import sys

# Add the project root to the Python path
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from backend.app import app

if __name__ == '__main__':
    print("AgriPulse BioRisk Engine - Starting on http://127.0.0.1:5000")
    app.run(port=5000, debug=False)
