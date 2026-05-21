/**
 * KRITECH Dashboard - Main Application Logic
 * Version: 2.0
 *
 * Handles:
 * - Data fetching and state management
 * - Map rendering with Leaflet
 * - Real-time threat visualization
 * - User interactions
 */

// ============================================================================
// GLOBAL STATE
// ============================================================================

let state = {
  currentRep: null,
  currentDate: null,
  threats: [],
  map: null,
  markers: [],
  pestSimulation: { active: false, district: null, boost: 0.4 },
  threatChart: null,
  refreshInterval: null,
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  console.log("🚀 KRITECH Dashboard Initialized");

  // Set default date to today
  const today = new Date().toISOString().split("T")[0];
  document.getElementById("simDate").value = today;
  state.currentDate = today;

  // Load representatives
  loadRepresentatives();

  // Start auto-refresh every 5 minutes (300,000 ms)
  state.refreshInterval = setInterval(() => {
    if (state.currentRep) {
      console.log("🔄 Auto-refreshing dashboard...");
      loadDashboard();
    }
  }, 300000);
});

// ============================================================================
// API CALLS
// ============================================================================

async function loadRepresentatives() {
  try {
    showLoading(true);
    const response = await fetch("/api/init");

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    const reps = data.reps || [];

    const select = document.getElementById("repSelect");
    select.innerHTML =
      '<option value="">Select Representative...</option>' +
      reps.map((rep) => `<option value="${rep}">${rep}</option>`).join("");

    // Populate live global stats in top navbar
    const totalGrowers = data.total_growers || 0;
    const districts = data.districts || [];
    const govtAlerts = data.govt_alerts || [];

    const navGrowersEl = document.getElementById("navGlobalGrowers");
    const navDistrictsEl = document.getElementById("navGlobalDistricts");
    const alertTextEl = document.getElementById("govtAlertText");

    if (navGrowersEl) navGrowersEl.textContent = totalGrowers.toLocaleString();
    if (navDistrictsEl) navDistrictsEl.textContent = districts.length;

    if (alertTextEl && govtAlerts.length > 0) {
      let alertIdx = 0;
      alertTextEl.textContent = govtAlerts[0];
      if (govtAlerts.length > 1) {
        setInterval(() => {
          alertTextEl.style.opacity = "0";
          setTimeout(() => {
            alertIdx = (alertIdx + 1) % govtAlerts.length;
            alertTextEl.textContent = govtAlerts[alertIdx];
            alertTextEl.style.opacity = "1";
          }, 300);
        }, 5000);
      }
    }

    // Load districts for simulator
    loadDistricts(districts);
  } catch (error) {
    console.error("Error loading reps:", error);
    showError("Failed to load representatives. Please refresh the page.");
  } finally {
    showLoading(false);
  }
}

function loadDistricts(districts) {
  try {
    const select = document.getElementById("simDistrict");
    if (!select) return;

    select.innerHTML =
      '<option value="">Select district to simulate outbreak...</option>' +
      districts.map((d) => `<option value="${d}">${d}</option>`).join("");
  } catch (error) {
    console.error("Error loading districts:", error);
  }
}

async function loadDashboard() {
  const repId = document.getElementById("repSelect").value;
  const simDate = document.getElementById("simDate").value;

  if (!repId) {
    clearDashboard();
    return;
  }

  state.currentRep = repId;
  state.currentDate = simDate;

  showLoading(true);
  hideError();

  let url = `/api/dashboard/${encodeURIComponent(repId)}?date=${simDate}`;

  if (state.pestSimulation.active && state.pestSimulation.district) {
    url += `&sim_district=${encodeURIComponent(
      state.pestSimulation.district
    )}&sim_boost=${state.pestSimulation.boost}`;
  }

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    state.threats = data.threats || [];

    const rep_info = {
      state: data.state,
      district: data.district,
      tehsils: data.tehsils,
      total_growers: data.stats?.total_growers || 0,
    };

    updateStats(data);
    updateThreatsTable(state.threats);
    updateMap(state.threats);
    updateSidebar(rep_info);
    updateWeather({
      current: data.weather,
      risk: { advice: data.weather_interpretation },
      diseases: data.district_diseases,
    });
    updateRoute({ stops: data.route, monitoring_only: data.monitoring_only });
    updateInactionCost({
      revenue_loss: data.consequence?.revenue_loss,
      yield_loss_pct: data.consequence?.yield_loss_pct,
      churn_risk: data.consequence?.churn_risk,
      baseline_message: data.consequence?.baseline_message,
    });
    updateWhatIf(data.visit_scenarios);
    updateMarketPrices(data.market);
    await loadMLWeights();

    const now = new Date();
    document.getElementById("lastUpdated").textContent =
      now.toLocaleTimeString();

    showToast("Dashboard updated successfully", "success");
  } catch (error) {
    console.error("Error loading dashboard:", error);
    showError(error.message);
  } finally {
    showLoading(false);
  }
}

// ============================================================================
// UI UPDATE FUNCTIONS
// ============================================================================

async function loadMLWeights() {
  try {
    const response = await fetch("/api/ml-weights");
    const data = await response.json();
    updateMLWeights(data.weights);
  } catch (error) {
    console.error("Error loading ML weights:", error);
  }
}

function updateStats(data) {
  const threats = data.threats || [];

  const critical = threats.filter((t) => t.threat_level === "CRITICAL").length;
  const high = threats.filter((t) => t.threat_level === "HIGH").length;
  const stockouts = threats.filter((t) => t.stockouts > 0).length;
  const totalRevenue = threats.reduce(
    (sum, t) => sum + (t.revenue_at_risk || 0),
    0
  );

  document.getElementById("statCritical").textContent = critical;
  document.getElementById("statHigh").textContent = high;
  document.getElementById("statStockouts").textContent = stockouts;
  document.getElementById("statRevenue").innerHTML =
    formatCurrency(totalRevenue);
}

function updateThreatsTable(threats) {
  const tbody = document.getElementById("threatsTableBody");

  if (!threats || threats.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-8 text-slate-400">
          <i class="fas fa-check-circle text-green-500 text-2xl mb-2 block"></i>
          No threats detected in your territory
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = threats
    .map(
      (threat, index) => `
        <tr class="hover:bg-slate-50 cursor-pointer transition" onclick="showTehsilDetail('${
          threat.tehsil
        }')">
          <td class="px-4 py-3">
            <span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-100 text-slate-600 text-xs font-bold">
              ${index + 1}
            </span>
          </td>
          <td class="px-4 py-3 font-semibold text-slate-700">${escapeHtml(
            threat.tehsil
          )}</td>
          <td class="px-4 py-3">
            <div class="flex items-center gap-2">
              <span class="text-lg font-bold ${getHeatScoreColor(
                threat.heat_score
              )}">${Math.round(threat.heat_score)}</span>
              <div class="progress-bar w-16">
                <div class="progress-fill ${getProgressClass(
                  threat.threat_level
                )}" style="width: ${threat.heat_score}%"></div>
              </div>
            </div>
          </td>
          <td class="px-4 py-3">
            <div class="flex gap-1 flex-wrap">
              <span class="score-chip score-chip-bio" data-tooltip="Biological Window">🌱 ${
                threat.score_breakdown?.bio || 0
              }</span>
              <span class="score-chip score-chip-inv" data-tooltip="Inventory Pressure">📦 ${
                threat.score_breakdown?.inv || 0
              }</span>
              <span class="score-chip score-chip-dig" data-tooltip="Digital Engagement">📱 ${
                threat.score_breakdown?.dig || 0
              }</span>
              <span class="score-chip score-chip-rec" data-tooltip="Visit Recency">⏰ ${
                threat.score_breakdown?.rec || 0
              }</span>
              <span class="score-chip score-chip-pos" data-tooltip="POS Momentum">📈 ${
                threat.score_breakdown?.pos || 0
              }</span>
            </div>
          </td>
          <td class="px-4 py-3">
            <span class="badge ${getBadgeClass(threat.threat_level)}">
              ${getThreatIcon(threat.threat_level)} ${threat.threat_level}
            </span>
          </td>
          <td class="px-4 py-3">
            <div class="font-medium">${threat.dominant_crop || "-"}</div>
            <div class="text-xs text-slate-400">${
              threat.dominant_stage || "-"
            }</div>
            <div class="text-xs text-slate-400">${
              threat.critical_growers || 0
            } vulnerable growers</div>
          </td>
          <td class="px-4 py-3">
            <button onclick="event.stopPropagation(); showActions('${
              threat.tehsil
            }')" 
                    class="text-xs bg-indigo-50 hover:bg-indigo-100 text-indigo-600 px-2 py-1 rounded-lg transition">
              <i class="fas fa-tasks mr-1"></i> Actions
            </button>
          </td>
        </tr>
      `
    )
    .join("");
}

function updateMap(threats) {
  if (!state.map) {
    state.map = L.map("map").setView([22.0, 78.0], 5);
    L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        subdomains: "abcd",
        maxZoom: 19,
      }
    ).addTo(state.map);
  }

  state.markers.forEach((marker) => state.map.removeLayer(marker));
  state.markers = [];

  threats.forEach((threat) => {
    if (threat.lat && threat.lng) {
      const markerColor = getMarkerColor(threat.threat_level);
      const markerSize = Math.max(12, Math.min(24, threat.heat_score / 5));

      const marker = L.circleMarker([threat.lat, threat.lng], {
        radius: markerSize,
        fillColor: markerColor,
        color: "white",
        weight: 2,
        opacity: 1,
        fillOpacity: 0.8,
      }).addTo(state.map);

      marker.bindPopup(`
        <div class="p-2 min-w-[200px]">
          <div class="font-bold text-base">${escapeHtml(threat.tehsil)}</div>
          <div class="text-sm mt-1">
            <span class="badge ${getBadgeClass(threat.threat_level)}">${
        threat.threat_level
      }</span>
          </div>
          <div class="text-xs text-slate-500 mt-2">
            🔥 Heat Score: <strong>${threat.heat_score}</strong><br>
            🌾 Crop: ${threat.dominant_crop} (${threat.dominant_stage})<br>
            📦 Stock: ${threat.inventory?.[0]?.qty || 0} units<br>
            👥 Growers: ${threat.num_growers}
          </div>
          <button onclick="selectTehsil('${threat.tehsil}')" 
                  class="mt-2 w-full bg-indigo-500 hover:bg-indigo-600 text-white text-xs py-1.5 rounded transition">
            View Details →
          </button>
        </div>
      `);

      state.markers.push(marker);
    }
  });

  if (state.markers.length > 0) {
    const group = L.featureGroup(state.markers);
    state.map.fitBounds(group.getBounds().pad(0.2));
  }
}

function updateSidebar(repInfo) {
  const card = document.getElementById("territoryCard");

  if (repInfo && repInfo.tehsils && repInfo.tehsils.length > 0) {
    document.getElementById("infoState").textContent = repInfo.state || "-";
    document.getElementById("infoDistrict").textContent =
      repInfo.district || "-";
    document.getElementById("infoTehsils").textContent = repInfo.tehsils.length;
    document.getElementById("infoGrowers").textContent =
      repInfo.total_growers || "-";
    card.classList.remove("hidden");
  } else {
    card.classList.add("hidden");
  }
}

function updateWeather(weatherData) {
  const card = document.getElementById("weatherCard");

  console.log("Weather data received:", weatherData);

  if (!weatherData || !weatherData.current) {
    console.warn("No weather data available, showing fallback");
    showFallbackWeather();
    return;
  }

  const current = weatherData.current;
  const risk = weatherData.risk || {};
  const diseases = weatherData.diseases || [];

  const humidity = current.humidity_avg || current.humidity || 65;
  const temp = current.temperature_avg || current.temperature || 25;
  const rain = current.rainfall_mm || current.rainfall || 0;
  const wind = current.wind_speed || 0;
  const wetness = current.leaf_wetness || current.leaf_wetness_hours || 0;

  document.getElementById("weatherHumidity").textContent = `${humidity}%`;
  document.getElementById("weatherTemp").textContent = `${temp}°C`;
  document.getElementById("weatherRain").textContent = `${rain}mm`;
  document.getElementById("weatherWind").textContent = `${wind}km/h`;

  const wetnessEl = document.getElementById("weatherWetness");
  if (wetnessEl) wetnessEl.textContent = `${wetness}h`;

  const weatherIcon = document.getElementById("weatherIcon");
  if (rain > 0) {
    weatherIcon.className = "fas fa-cloud-rain text-2xl text-blue-500";
  } else if (humidity > 75) {
    weatherIcon.className = "fas fa-cloud-sun text-2xl text-amber-500";
  } else {
    weatherIcon.className = "fas fa-sun text-2xl text-yellow-500";
  }

  const alertDiv = document.getElementById("weatherAlert");
  let adviceText = risk.advice
    ? `<div class="mb-2"><i class="fas fa-exclamation-triangle mr-1"></i> ${risk.advice}</div>`
    : "";

  // Agricultural Intelligence Explainability
  if (diseases.length > 0) {
    const highRiskDiseases = diseases.filter(
      (d) => d.risk_level === "HIGH" || d.risk_level === "CRITICAL"
    );
    if (highRiskDiseases.length > 0) {
      const dName = highRiskDiseases[0].disease.replace(/_/g, " ");
      adviceText += `<div class="mt-2 pt-2 border-t border-amber-200 text-[11px] font-semibold text-amber-800">
        <i class="fas fa-bug mr-1"></i> Pest Intel: Current weather actively supports the spread of ${dName} in ${
        highRiskDiseases[0].crop
      }. 
        ${
          wetness > 4
            ? `The ${wetness}h of leaf wetness is highly conducive for spore germination.`
            : ""
        }
      </div>`;
    }
  }

  if (adviceText) {
    alertDiv.innerHTML = adviceText;
    alertDiv.classList.remove("hidden");
  } else {
    alertDiv.classList.add("hidden");
  }

  card.classList.remove("hidden");
}

function showFallbackWeather() {
  const card = document.getElementById("weatherCard");

  document.getElementById("weatherHumidity").textContent = "--%";
  document.getElementById("weatherTemp").textContent = "--°C";
  document.getElementById("weatherRain").textContent = "--mm";
  document.getElementById("weatherWind").textContent = "--km/h";

  const wetnessEl = document.getElementById("weatherWetness");
  if (wetnessEl) wetnessEl.textContent = "--h";

  const weatherIcon = document.getElementById("weatherIcon");
  weatherIcon.className = "fas fa-cloud text-2xl text-slate-400";

  const alertDiv = document.getElementById("weatherAlert");
  alertDiv.innerHTML = `<i class="fas fa-info-circle mr-1"></i> Live weather data unavailable`;
  alertDiv.className =
    "text-xs p-2 rounded-lg bg-slate-50 text-slate-500 mt-2 block";

  card.classList.remove("hidden");
  console.log("Showing empty state for weather data");
}

function updateRoute(routeData) {
  const container = document.getElementById("routeList");
  const subtitle = document.getElementById("routeSubtitle");

  if (!routeData || !routeData.stops || routeData.stops.length === 0) {
    container.innerHTML = `
      <div class="text-center py-8 text-slate-400">
        <i class="fas fa-road text-3xl mb-2 block"></i>
        No optimized route available
      </div>
    `;
    return;
  }

  if (routeData.monitoring_only) {
    subtitle.innerHTML =
      '<i class="fas fa-eye mr-1"></i> No critical threats — showing top tehsils for monitoring';
  } else {
    subtitle.innerHTML = `<i class="fas fa-route mr-1"></i> ${routeData.stops.length} stops optimized by urgency`;
  }

  container.innerHTML = routeData.stops
    .map(
      (stop) => `
        <div class="route-item flex items-start gap-3">
          <div class="route-number">${stop.sequence}</div>
          <div class="flex-1">
            <div class="font-semibold text-slate-800">${escapeHtml(
              stop.tehsil
            )}</div>
            <div class="text-xs text-slate-500 mt-0.5">${
              stop.why_visit?.join(", ") || stop.next_action
            }</div>
            <div class="flex gap-3 mt-1 text-xs text-slate-400">
              <span><i class="fas fa-fire text-orange-500"></i> ${
                stop.heat_score
              }</span>
              <span><i class="fas fa-store"></i> ${
                stop.retailers_count
              } retailers</span>
              <span><i class="fas fa-clock"></i> ${stop.est_time_hours}h</span>
              <span><i class="fas fa-calendar-alt"></i> ${
                stop.days_since_visit
              }d since visit</span>
            </div>
          </div>
          <div>
            <span class="badge ${getBadgeClass(stop.threat_level)}">${
        stop.threat_level
      }</span>
          </div>
        </div>
      `
    )
    .join("");
}

function updateInactionCost(inaction) {
  const container = document.getElementById("inactionContent");

  if (!inaction || !inaction.revenue_loss) {
    container.innerHTML =
      '<div class="text-center text-slate-400 text-sm">Select a tehsil to see projections</div>';
    return;
  }

  container.innerHTML = `
    <div class="bg-white/50 rounded-lg p-3 text-center">
      <div class="text-2xl font-bold text-red-600">${formatCurrency(
        inaction.revenue_loss
      )}</div>
      <div class="text-xs text-slate-500">Projected Revenue Loss</div>
    </div>
    <div class="grid grid-cols-2 gap-2">
      <div class="bg-white/50 rounded-lg p-2 text-center">
        <div class="text-lg font-bold text-amber-600">${
          inaction.yield_loss_pct || 0
        }%</div>
        <div class="text-[10px] text-slate-500">Yield Loss</div>
      </div>
      <div class="bg-white/50 rounded-lg p-2 text-center">
        <div class="text-lg font-bold ${getChurnColor(inaction.churn_risk)}">${
    inaction.churn_risk || "LOW"
  }</div>
        <div class="text-[10px] text-slate-500">Churn Risk</div>
      </div>
    </div>
    ${
      inaction.baseline_message
        ? `<div class="text-xs text-slate-500 italic mt-2">💡 ${inaction.baseline_message}</div>`
        : ""
    }
    <div class="text-[10px] text-slate-400 text-center mt-2">Based on 14-day inaction scenario</div>
  `;
}

function updateWhatIf(whatIf) {
  const container = document.getElementById("whatIfContent");

  if (!whatIf || !whatIf.current_risk) {
    container.innerHTML =
      '<div class="text-center text-slate-400 text-sm">Select a tehsil to see projections</div>';
    return;
  }

  const reduction = whatIf.current_risk - whatIf.visit_tomorrow;

  container.innerHTML = `
    <div class="space-y-3">
      <div class="flex justify-between items-center">
        <span class="text-sm text-slate-600">Current Risk:</span>
        <span class="text-xl font-bold text-red-500">${Math.round(
          whatIf.current_risk
        )}</span>
      </div>
      <div class="flex justify-between items-center">
        <span class="text-sm text-slate-600">After Tomorrow's Visit:</span>
        <span class="text-xl font-bold text-emerald-600">${Math.round(
          whatIf.visit_tomorrow
        )}</span>
      </div>
      <div class="bg-emerald-50 rounded-lg p-2 text-center">
        <span class="text-sm font-semibold text-emerald-700">
          ${
            reduction > 0
              ? `📉 Risk Reduction: ${Math.round(reduction)} points`
              : "⚡ Visit as soon as possible"
          }
        </span>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class="text-center">
          <div class="text-slate-400">After 3 days</div>
          <div class="font-bold ${
            whatIf.visit_3days > whatIf.current_risk
              ? "text-red-500"
              : "text-amber-500"
          }">
            ${Math.round(whatIf.visit_3days)}
          </div>
        </div>
        <div class="text-center">
          <div class="text-slate-400">If ignored (7d)</div>
          <div class="font-bold text-red-500">${Math.round(
            whatIf.ignore_7days
          )}</div>
        </div>
      </div>
    </div>
  `;
}

function updateMarketPrices(prices) {
  const container = document.getElementById("marketPrices");

  if (!prices || Object.keys(prices).length === 0) {
    container.innerHTML =
      '<div class="col-span-4 text-center text-slate-400">No market price data available</div>';
    return;
  }

  container.innerHTML = Object.entries(prices)
    .slice(0, 8)
    .map(
      ([crop, data]) => `
        <div class="bg-slate-50 rounded-lg p-3 text-center hover:shadow-md transition">
          <div class="text-xs uppercase text-slate-400 font-semibold">${escapeHtml(
            crop
          )}</div>
          <div class="text-lg font-bold text-slate-700">₹${Math.round(
            data.price || 0
          )}</div>
          <div class="text-xs ${
            data.change > 0 ? "text-green-500" : "text-red-500"
          }">
            ${data.change > 0 ? "▲" : "▼"} ${Math.abs(data.change || 0)}%
          </div>
          <div class="text-[10px] text-slate-400">${
            data.trend || "stable"
          }</div>
        </div>
      `
    )
    .join("");
}

function updateMLWeights(weights) {
  const container = document.getElementById("mlWeights");
  const explanation = document.getElementById("mlExplanation");

  if (!weights) {
    container.innerHTML =
      '<div class="text-xs text-slate-400">ML weights loading...</div>';
    return;
  }

  container.innerHTML = `
    <div class="space-y-3">
      <div>
        <div class="flex justify-between text-xs font-semibold mb-1">
          <span class="text-slate-700">🌱 Biological Window</span>
          <span class="text-indigo-600">${Math.round(
            weights.bio_window * 100
          )}%</span>
        </div>
        <div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full" style="width: ${
            weights.bio_window * 100
          }%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs font-semibold mb-1">
          <span class="text-slate-700">📦 Inventory Pressure</span>
          <span class="text-indigo-600">${Math.round(
            weights.inv_pressure * 100
          )}%</span>
        </div>
        <div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full" style="width: ${
            weights.inv_pressure * 100
          }%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs font-semibold mb-1">
          <span class="text-slate-700">📱 Digital Warmth</span>
          <span class="text-indigo-600">${Math.round(
            weights.dig_warmth * 100
          )}%</span>
        </div>
        <div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-emerald-400 to-teal-500 rounded-full" style="width: ${
            weights.dig_warmth * 100
          }%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs font-semibold mb-1">
          <span class="text-slate-700">⏰ Visit Recency</span>
          <span class="text-indigo-600">${Math.round(
            weights.visit_recency * 100
          )}%</span>
        </div>
        <div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-amber-400 to-orange-500 rounded-full" style="width: ${
            weights.visit_recency * 100
          }%"></div>
        </div>
      </div>
      <div>
        <div class="flex justify-between text-xs font-semibold mb-1">
          <span class="text-slate-700">📈 POS Momentum</span>
          <span class="text-indigo-600">${Math.round(
            weights.pos_momentum * 100
          )}%</span>
        </div>
        <div class="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <div class="h-full bg-gradient-to-r from-rose-400 to-red-500 rounded-full" style="width: ${
            weights.pos_momentum * 100
          }%"></div>
        </div>
      </div>
    </div>
  `;

  explanation.innerHTML = `
    <i class="fas fa-chart-line mr-1"></i>
    ML weights trained on 500 historical visit outcomes using Random Forest regression.
    Biological window has highest impact (${Math.round(
      weights.bio_window * 100
    )}%) as crop stage is the strongest predictor of disease risk.
  `;
}

function updateThreatChart(threats) {
  const canvas = document.getElementById("threatChart");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const labels = threats.slice(0, 6).map((t) => t.tehsil.split(" ")[0]);
  const scores = threats.slice(0, 6).map((t) => t.heat_score);

  if (state.threatChart) {
    state.threatChart.destroy();
  }

  state.threatChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Heat Score",
          data: scores,
          backgroundColor: scores.map((s) =>
            s >= 50
              ? "#ef4444"
              : s >= 35
              ? "#f97316"
              : s >= 20
              ? "#eab308"
              : "#22c55e"
          ),
          borderRadius: 8,
          barPercentage: 0.7,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `Heat Score: ${ctx.raw}` } },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          title: { display: true, text: "Threat Score" },
        },
      },
    },
  });
}

// ============================================================================
// TEHSIL DETAIL FUNCTIONS - FIXED (No API call, uses existing data)
// ============================================================================

function loadThreatDetail(tehsilName) {
  const threat = state.threats.find((t) => t.tehsil === tehsilName);
  if (!threat) {
    console.error("Threat not found:", tehsilName);
    showError("Threat data not found");
    return;
  }

  // Display modal directly from existing threat data (NO API CALL)
  displayThreatModal(threat);
}

function displayThreatModal(threat) {
  const modal = document.getElementById("threatModal");
  const content = document.getElementById("threatModalContent");

  // Update header
  document.getElementById("modalTehsilName").textContent =
    threat.tehsil || "Threat Intelligence";
  document.getElementById("modalDistrictName").textContent =
    threat.district || "";

  const pestIntel = threat.pest_climate_intel || {};
  const advisory = threat.agri_advisory || {};
  const isCritical = threat.threat_level === "CRITICAL";
  const isHigh = threat.threat_level === "HIGH";

  const headerBgClass = isCritical
    ? "bg-red-50 border-red-200"
    : isHigh
    ? "bg-orange-50 border-orange-200"
    : "bg-amber-50 border-amber-200";

  content.innerHTML = `
    <!-- Threat Level Header -->
    <div class="${headerBgClass} rounded-xl p-4 border flex items-center justify-between">
      <div>
        <span class="text-xs uppercase tracking-wider font-semibold text-slate-500">Current Threat Level</span>
        <div class="text-2xl font-bold mt-1 ${
          isCritical
            ? "text-red-600"
            : isHigh
            ? "text-orange-600"
            : "text-amber-600"
        }">
          ${threat.threat_level || "LOW"}
        </div>
      </div>
      <div class="text-right">
        <div class="text-xs text-slate-500">Heat Score</div>
        <div class="text-3xl font-bold ${getHeatScoreColor(
          threat.heat_score
        )}">${Math.round(threat.heat_score || 0)}</div>
      </div>
    </div>

    <!-- Component Scores -->
    <div class="bg-slate-50 rounded-xl p-4">
      <div class="text-xs font-semibold text-slate-600 mb-3 uppercase tracking-wider">Component Scores</div>
      <div class="grid grid-cols-5 gap-2">
        <div class="bg-white rounded-lg p-2 text-center shadow-sm"><div class="font-bold text-slate-700">${
          threat.score_breakdown?.bio || 0
        }</div><div class="text-[10px] text-slate-500">🌱 Bio</div></div>
        <div class="bg-white rounded-lg p-2 text-center shadow-sm"><div class="font-bold text-slate-700">${
          threat.score_breakdown?.inv || 0
        }</div><div class="text-[10px] text-slate-500">📦 Inv</div></div>
        <div class="bg-white rounded-lg p-2 text-center shadow-sm"><div class="font-bold text-slate-700">${
          threat.score_breakdown?.dig || 0
        }</div><div class="text-[10px] text-slate-500">📱 Dig</div></div>
        <div class="bg-white rounded-lg p-2 text-center shadow-sm"><div class="font-bold text-slate-700">${
          threat.score_breakdown?.rec || 0
        }</div><div class="text-[10px] text-slate-500">⏰ Rec</div></div>
        <div class="bg-white rounded-lg p-2 text-center shadow-sm"><div class="font-bold text-slate-700">${
          threat.score_breakdown?.pos || 0
        }</div><div class="text-[10px] text-slate-500">📈 POS</div></div>
      </div>
    </div>

    <!-- Crop & Grower Status -->
    <div class="grid grid-cols-2 gap-4">
      <div class="bg-emerald-50 rounded-xl p-4 border border-emerald-100">
        <div class="text-xs text-emerald-700 font-semibold uppercase tracking-wider">Dominant Crop</div>
        <div class="text-xl font-bold text-slate-800 mt-1">${
          threat.dominant_crop || "Unknown"
        }</div>
        <div class="text-sm text-emerald-600 mt-0.5">${
          threat.dominant_stage || "Unknown Stage"
        }</div>
      </div>
      <div class="bg-blue-50 rounded-xl p-4 border border-blue-100">
        <div class="text-xs text-blue-700 font-semibold uppercase tracking-wider">Grower Status</div>
        <div class="text-xl font-bold text-slate-800 mt-1">${
          threat.num_growers || 0
        }</div>
        <div class="text-sm text-blue-600">${
          threat.critical_growers || 0
        } vulnerable growers</div>
      </div>
    </div>

    ${
      pestIntel.available
        ? `
    <!-- Pest Climate Intelligence -->
    <div class="border border-amber-200 rounded-xl p-4 bg-amber-50">
      <div class="flex items-center gap-2 mb-3">
        <i class="fas fa-biohazard text-amber-600"></i>
        <span class="text-xs font-bold text-amber-800 uppercase tracking-wider">Pest Climate Intelligence</span>
      </div>
      <div class="space-y-3 text-sm">
        <div class="font-semibold text-amber-900">${
          pestIntel.scientific_name || "Unknown Pathogen"
        }</div>
        <div class="flex items-center gap-2">
          <span class="px-2 py-0.5 rounded-full text-xs font-bold ${
            pestIntel.overall?.status === "ACTIVE_THREAT"
              ? "bg-red-500 text-white"
              : "bg-amber-200 text-amber-800"
          }">${pestIntel.overall?.status || "MONITOR"}</span>
          <span class="text-amber-800">${
            pestIntel.overall?.message || "Conditions being monitored"
          }</span>
        </div>
        <div class="grid grid-cols-1 gap-2 text-xs">
          <div class="bg-white/60 rounded-lg p-2"><span class="font-semibold">🌡️ Temperature:</span> ${
            pestIntel.temperature?.detail || "Data unavailable"
          }</div>
          <div class="bg-white/60 rounded-lg p-2"><span class="font-semibold">💧 Humidity:</span> ${
            pestIntel.humidity?.detail || "Data unavailable"
          }</div>
          <div class="bg-white/60 rounded-lg p-2"><span class="font-semibold">💦 Leaf Wetness:</span> ${
            pestIntel.leaf_wetness?.detail || "Data unavailable"
          }</div>
        </div>
        ${
          pestIntel.forecast_warning
            ? `<div class="bg-red-100 border border-red-300 rounded-lg p-2 text-red-800 text-xs">⚠️ ${pestIntel.forecast_warning}</div>`
            : ""
        }
        <div class="text-xs text-amber-800 border-t border-amber-200 pt-2"><span class="font-semibold">🔍 Field Sign:</span> ${
          pestIntel.field_sign || "Monitor for unusual symptoms"
        }</div>
      </div>
    </div>
    `
        : ""
    }

    ${
      advisory.guide
        ? `
    <!-- Agricultural Advisory -->
    <div class="border border-green-200 rounded-xl p-4 bg-green-50">
      <div class="flex items-center gap-2 mb-3">
        <i class="fas fa-leaf text-green-600"></i>
        <span class="text-xs font-bold text-green-800 uppercase tracking-wider">Agricultural Advisory</span>
      </div>
      <div class="space-y-2 text-sm">
        <div><span class="font-semibold">Symptoms:</span> ${
          advisory.symptoms || "Monitor for unusual signs"
        }</div>
        <div><span class="font-semibold">Conditions:</span> ${
          advisory.conditions || "Standard growing conditions"
        }</div>
        <div><span class="font-semibold">Impact:</span> ${
          advisory.impact || "Monitor and report"
        }</div>
        <div class="bg-white rounded-lg p-2 mt-2"><span class="font-semibold">📋 Guide:</span> ${
          advisory.guide || "Consult local extension office"
        }</div>
        ${
          advisory.product
            ? `<div class="mt-2"><span class="font-semibold">🧪 Recommended Product:</span> ${
                advisory.product
              } (₹${advisory.cost || 0}/acre)</div>`
            : ""
        }
      </div>
    </div>
    `
        : ""
    }

    <!-- Inventory Status -->
    <div class="border border-slate-200 rounded-xl p-4">
      <div class="flex items-center gap-2 mb-3">
        <i class="fas fa-boxes text-slate-500"></i>
        <span class="text-xs font-bold text-slate-600 uppercase tracking-wider">Inventory Status</span>
      </div>
      ${
        threat.inventory && threat.inventory.length > 0
          ? threat.inventory
              .map(
                (inv) => `
        <div class="flex justify-between items-center py-2 border-b border-slate-100 last:border-0">
          <span class="text-sm font-medium">${inv.product}</span>
          <span class="badge ${
            inv.status === "CRITICAL"
              ? "badge-critical"
              : inv.status === "LOW"
              ? "badge-high"
              : "badge-low"
          }">${inv.qty} units</span>
        </div>
        <div class="text-xs text-slate-500 mt-1">📊 ${inv.prediction}</div>
      `
              )
              .join("")
          : "<div class='text-slate-500 text-sm'>No inventory data available</div>"
      }
    </div>

    <!-- Concerns & Actions -->
    <div class="grid grid-cols-2 gap-4">
      <div class="border border-red-200 rounded-xl p-4 bg-red-50">
        <div class="flex items-center gap-2 mb-2">
          <i class="fas fa-exclamation-triangle text-red-500"></i>
          <span class="text-xs font-bold text-red-700 uppercase tracking-wider">Concerns</span>
        </div>
        <ul class="text-xs text-red-700 space-y-1">
          ${
            threat.concerns
              ? threat.concerns
                  .slice(0, 3)
                  .map(
                    (c) =>
                      `<li class="flex items-start gap-1"><span>•</span> ${c}</li>`
                  )
                  .join("")
              : "<li>• No major concerns identified</li>"
          }
        </ul>
      </div>
      <div class="border border-green-200 rounded-xl p-4 bg-green-50">
        <div class="flex items-center gap-2 mb-2">
          <i class="fas fa-check-circle text-green-500"></i>
          <span class="text-xs font-bold text-green-700 uppercase tracking-wider">Actions</span>
        </div>
        <ul class="text-xs text-green-700 space-y-1">
          ${
            threat.actions
              ? threat.actions
                  .slice(0, 3)
                  .map(
                    (a) =>
                      `<li class="flex items-start gap-1"><span>✓</span> ${a}</li>`
                  )
                  .join("")
              : "<li>• Continue monitoring</li>"
          }
        </ul>
      </div>
    </div>

    ${
      threat.visit_scenarios
        ? `
    <!-- What-If Scenarios -->
    <div class="border border-indigo-200 rounded-xl p-4 bg-indigo-50">
      <div class="flex items-center gap-2 mb-3">
        <i class="fas fa-chart-line text-indigo-500"></i>
        <span class="text-xs font-bold text-indigo-700 uppercase tracking-wider">What-If Scenarios</span>
      </div>
      <div class="grid grid-cols-2 gap-3 text-center">
        <div class="bg-white rounded-lg p-3"><div class="text-xs text-slate-500">Current Risk</div><div class="text-xl font-bold text-red-600">${threat.visit_scenarios.current_risk}</div></div>
        <div class="bg-white rounded-lg p-3"><div class="text-xs text-slate-500">Visit Tomorrow</div><div class="text-xl font-bold text-green-600">${threat.visit_scenarios.visit_tomorrow}</div></div>
        <div class="bg-white rounded-lg p-3"><div class="text-xs text-slate-500">After 3 Days</div><div class="text-xl font-bold text-yellow-600">${threat.visit_scenarios.visit_3days}</div></div>
        <div class="bg-white rounded-lg p-3"><div class="text-xs text-slate-500">If Ignored (7d)</div><div class="text-xl font-bold text-red-600">${threat.visit_scenarios.ignore_7days}</div></div>
      </div>
    </div>
    `
        : ""
    }
  `;

  // Show modal with animation
  modal.classList.remove("hidden");
  modal.scrollIntoView({ behavior: "smooth" });

  // Add ESC key listener
  document.addEventListener("keydown", function escHandler(e) {
    if (e.key === "Escape") {
      closeThreatModal();
      document.removeEventListener("keydown", escHandler);
    }
  });
}

function closeThreatModal() {
  const modal = document.getElementById("threatModal");
  if (modal) {
    modal.classList.add("hidden");
  }
}

function showTehsilDetail(tehsilName) {
  loadThreatDetail(tehsilName);
}

function selectTehsil(tehsilName) {
  showTehsilDetail(tehsilName);
}

function showActions(tehsilName) {
  const threat = state.threats.find((t) => t.tehsil === tehsilName);
  if (!threat) return;

  alert(
    `Recommended Actions for ${tehsilName}:\n\n${
      threat.actions?.join("\n") || "Continue monitoring"
    }`
  );
}

// ============================================================================
// SIMULATION FUNCTIONS
// ============================================================================

function triggerPestSimulation() {
  const district = document.getElementById("simDistrict").value;

  if (!district) {
    showError("Please select a district first");
    return;
  }

  state.pestSimulation.active = true;
  state.pestSimulation.district = district;

  document.getElementById("resetPestBtn").classList.remove("hidden");
  loadDashboard();
  showToast(`⚠️ Pest outbreak simulation ACTIVE for ${district}`, "warning");
}

function resetPestSimulation() {
  state.pestSimulation.active = false;
  state.pestSimulation.district = null;

  document.getElementById("resetPestBtn").classList.add("hidden");
  document.getElementById("simDistrict").value = "";
  loadDashboard();
  showToast("Simulation reset to normal conditions", "info");
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function formatCurrency(amount) {
  if (!amount) return "₹0";
  if (amount >= 10000000) return `₹${(amount / 10000000).toFixed(1)}Cr`;
  if (amount >= 100000) return `₹${(amount / 100000).toFixed(1)}L`;
  if (amount >= 1000) return `₹${(amount / 1000).toFixed(0)}K`;
  return `₹${Math.round(amount)}`;
}

function getHeatScoreColor(score) {
  if (score >= 50) return "text-red-600";
  if (score >= 35) return "text-orange-500";
  if (score >= 20) return "text-yellow-600";
  return "text-green-600";
}

function getProgressClass(level) {
  switch (level) {
    case "CRITICAL":
      return "progress-critical";
    case "HIGH":
      return "progress-high";
    case "MEDIUM":
      return "progress-medium";
    default:
      return "progress-low";
  }
}

function getBadgeClass(level) {
  switch (level) {
    case "CRITICAL":
      return "badge-critical";
    case "HIGH":
      return "badge-high";
    case "MEDIUM":
      return "badge-medium";
    default:
      return "badge-low";
  }
}

function getThreatIcon(level) {
  switch (level) {
    case "CRITICAL":
      return "🔴";
    case "HIGH":
      return "🟠";
    case "MEDIUM":
      return "🟡";
    default:
      return "🟢";
  }
}

function getMarkerColor(level) {
  switch (level) {
    case "CRITICAL":
      return "#ef4444";
    case "HIGH":
      return "#f97316";
    case "MEDIUM":
      return "#eab308";
    default:
      return "#22c55e";
  }
}

function getChurnColor(risk) {
  switch (risk) {
    case "CRITICAL":
      return "text-red-600";
    case "HIGH":
      return "text-orange-500";
    case "MEDIUM":
      return "text-yellow-600";
    default:
      return "text-green-600";
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/[&<>]/g, function (m) {
    if (m === "&") return "&amp;";
    if (m === "<") return "&lt;";
    if (m === ">") return "&gt;";
    return m;
  });
}

function clearDashboard() {
  document.getElementById(
    "threatsTableBody"
  ).innerHTML = `<tr><td colspan="7" class="text-center py-8 text-slate-400">Select a representative to view priorities</td></table>`;
  document.getElementById("routeList").innerHTML = "";
  document.getElementById("marketPrices").innerHTML = "";
  document.getElementById("territoryCard").classList.add("hidden");
  document.getElementById("weatherCard").classList.add("hidden");
  document.getElementById("tehsilDetailCard").classList.add("hidden");
}

function exportToCSV() {
  if (!state.threats || state.threats.length === 0) {
    showError("No data to export");
    return;
  }

  const headers = [
    "Rank",
    "Tehsil",
    "Heat Score",
    "Threat Level",
    "Crop",
    "Stage",
    "Growers",
    "Revenue at Risk",
  ];
  const rows = state.threats.map((t, i) => [
    i + 1,
    t.tehsil,
    t.heat_score,
    t.threat_level,
    t.dominant_crop,
    t.dominant_stage,
    t.num_growers,
    t.revenue_at_risk,
  ]);

  const csvContent = [headers, ...rows].map((row) => row.join(",")).join("\n");
  const blob = new Blob([csvContent], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kritech_priorities_${
    new Date().toISOString().split("T")[0]
  }.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Export complete!", "success");
}

// ============================================================================
// UI HELPERS
// ============================================================================

function showLoading(show) {
  const overlay = document.getElementById("loadingOverlay");
  if (show) {
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }
}

function showError(message) {
  const toast = document.getElementById("errorToast");
  const msgSpan = document.getElementById("errorMessage");
  msgSpan.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => {
    toast.classList.add("hidden");
  }, 5000);
}

function hideError() {
  document.getElementById("errorToast").classList.add("hidden");
}

function showToast(message, type = "info") {
  console.log(`[${type.toUpperCase()}] ${message}`);
  if (type === "error") {
    showError(message);
  }
}

// Make functions globally available
window.loadRepresentatives = loadRepresentatives;
window.loadDistricts = loadDistricts;
window.loadDashboard = loadDashboard;
window.triggerPestSimulation = triggerPestSimulation;
window.resetPestSimulation = resetPestSimulation;
window.showTehsilDetail = showTehsilDetail;
window.selectTehsil = selectTehsil;
window.showActions = showActions;
window.exportToCSV = exportToCSV;
window.loadThreatDetail = loadThreatDetail;
window.closeThreatModal = closeThreatModal;

// ============================================================================
// TAB NAVIGATION
// ============================================================================

function switchTab(tabId) {
  // Hide all tab contents
  document.querySelectorAll(".tab-content").forEach((el) => {
    el.classList.add("hidden");
    el.classList.remove("block", "grid", "grid-cols-1", "lg:grid-cols-2");
  });

  // Reset all buttons
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.remove(
      "bg-teal-50",
      "text-teal-700",
      "border-teal-100",
      "shadow-sm",
      "font-semibold"
    );
    btn.classList.add(
      "bg-transparent",
      "text-slate-500",
      "border-transparent",
      "hover:bg-slate-50",
      "hover:text-slate-700",
      "font-medium"
    );
  });

  // Show active tab
  const activeTab = document.getElementById(tabId);
  if (activeTab) {
    activeTab.classList.remove("hidden");
    if (tabId === "tab-routing") {
      activeTab.classList.add("block");
    } else {
      activeTab.classList.add("grid", "grid-cols-1", "lg:grid-cols-2");
    }
  }

  // Highlight active button
  const activeBtn = document.getElementById("btn-" + tabId);
  if (activeBtn) {
    activeBtn.classList.remove(
      "bg-transparent",
      "text-slate-500",
      "border-transparent",
      "hover:bg-slate-50",
      "hover:text-slate-700",
      "font-medium"
    );
    activeBtn.classList.add(
      "bg-teal-50",
      "text-teal-700",
      "border-teal-100",
      "shadow-sm",
      "font-semibold"
    );
  }
}

window.switchTab = switchTab;
