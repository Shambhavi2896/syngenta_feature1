let weatherAbortController = null;
const weatherCache = new Map();
let mapInstance = null;
let chartInstance = null;
let currentData = null;
const todayDate = new Date().toISOString().slice(0, 10);

window.addEventListener("DOMContentLoaded", () => {
  loadInit();
});

async function loadInit() {
  try {
    const response = await fetch("/api/init");
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    if (!data || !data.reps) {
      throw new Error("Invalid response: missing reps data");
    }
    const repSelect = document.getElementById("repSelect");
    repSelect.innerHTML = '<option value="">Select Rep ID...</option>';
    if (data.reps.length === 0) {
      repSelect.innerHTML +=
        '<option value="" disabled>No reps available</option>';
    } else {
      data.reps.forEach((r) => {
        repSelect.innerHTML += `<option value="${r}">${r}</option>`;
      });
    }
    const districtSelect = document.getElementById("simDistrict");
    districtSelect.innerHTML = '<option value="">Select district...</option>';
    if (data.districts && data.districts.length > 0) {
      data.districts.forEach((district) => {
        districtSelect.innerHTML += `<option value="${district}">${district}</option>`;
      });
    } else {
      districtSelect.innerHTML =
        '<option value="" disabled>No districts available</option>';
    }

    if (data.latest_data_date) {
      document.getElementById("simDate").value = data.latest_data_date;
    } else {
      document.getElementById("simDate").value = todayDate;
    }

    showErrorMessage("", "success");
  } catch (error) {
    console.error("Initialization failed", error);
    showErrorMessage(`Failed to load: ${error.message}`, "error");
    document.getElementById("repSelect").innerHTML =
      '<option value="" disabled>Error loading reps</option>';
    document.getElementById("simDistrict").innerHTML =
      '<option value="" disabled>Error loading districts</option>';
  }
}

function showErrorMessage(msg, type) {
  const errorBox = document.getElementById("errorMessage");
  if (!errorBox) return;
  if (!msg) {
    errorBox.classList.add("hidden");
    return;
  }
  errorBox.textContent = msg;
  if (type === "error") {
    errorBox.className =
      "text-red-600 bg-red-50 border border-red-200 p-3 rounded-lg text-sm font-medium";
  } else {
    errorBox.className =
      "text-green-600 bg-green-50 border border-green-200 p-3 rounded-lg text-sm font-medium";
  }
  errorBox.classList.remove("hidden");
  if (type !== "error")
    setTimeout(() => errorBox.classList.add("hidden"), 3000);
}

async function fetchLiveWeather(lat, lng) {
  if (!lat || !lng) return null;
  const cacheKey = `${lat.toFixed(4)}_${lng.toFixed(4)}_${todayDate}`;
  if (weatherCache.has(cacheKey)) return weatherCache.get(cacheKey);
  if (weatherAbortController) weatherAbortController.abort();
  weatherAbortController = new AbortController();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&hourly=relativehumidity_2m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=Asia%2FKolkata`;
  try {
    const response = await fetch(url, {
      signal: weatherAbortController.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const current = data.current_weather || {};
    const timeIndex = data.hourly?.time?.indexOf(current.time || "");
    const humidity =
      timeIndex >= 0
        ? data.hourly.relativehumidity_2m[timeIndex]
        : data.hourly?.relativehumidity_2m?.[0] ?? null;
    const rainfall =
      timeIndex >= 0
        ? data.hourly.precipitation[timeIndex]
        : data.hourly?.precipitation?.[0] ?? 0;
    const live = {
      temperature: current.temperature ?? null,
      windspeed: current.windspeed ?? null,
      weathercode: current.weathercode ?? null,
      humidity,
      rainfall,
      forecast: data.daily || {},
    };
    weatherCache.set(cacheKey, live);
    return live;
  } catch (error) {
    console.warn("Live weather fetch failed", error);
    return null;
  }
}

function updateLiveWeather(liveWeather) {
  if (!liveWeather) return;
  document.getElementById("wHumidity").textContent = `${
    liveWeather.humidity ?? "-"
  }%`;
  document.getElementById("wRain").textContent = `${
    liveWeather.rainfall ?? 0
  }mm`;
  document.getElementById("wTemp").textContent = `${
    liveWeather.temperature ?? "-"
  }°C`;
  document.getElementById("wLeaf").textContent = `${
    liveWeather.windspeed ?? "-"
  } km/h`;
  const interpretation = [];
  if (
    liveWeather.humidity >= 80 &&
    liveWeather.temperature >= 22 &&
    liveWeather.temperature <= 30
  ) {
    interpretation.push(
      `HIGH RISK: warm humid conditions support fungal spread.`
    );
  } else if (liveWeather.humidity >= 70) {
    interpretation.push(
      `ELEVATED risk: humidity is high and crop wetness may rise.`
    );
  } else {
    interpretation.push(
      `Stable conditions: humidity and temperature are moderate.`
    );
  }
  if (liveWeather.rainfall >= 5) {
    interpretation.push(`Recent rain may increase disease pressure in fields.`);
  }
  const wi = document.getElementById("weatherInterpretation");
  wi.textContent = interpretation.join(" ");
  wi.classList.remove("hidden");
  renderForecast(liveWeather);
}

function computeAIConfidence(d) {
  const campaign = d.campaign || {};
  const threatBase = Math.min(
    1,
    ((d.stats?.critical || 0) * 1.5 + (d.stats?.high || 0)) /
      Math.max(d.threats?.length || 1, 1)
  );
  const engagement = Math.min(
    100,
    (campaign.open_rate || 0) * 0.35 + (campaign.click_rate || 0) * 0.25
  );
  const marketVolatility = Math.min(
    20,
    Object.values(d.market || {}).reduce(
      (acc, item) => acc + Math.abs(item?.change || 0),
      0
    ) * 0.1
  );
  const raw = 45 + threatBase * 25 + engagement * 0.2 + marketVolatility;
  return Math.round(Math.max(50, Math.min(98, raw)));
}

function renderForecast(liveWeather) {
  const forecastContainer = document.getElementById("weatherForecast");
  const list = document.getElementById("forecastList");
  const forecast = liveWeather?.forecast;
  if (!forecast?.time?.length) {
    forecastContainer.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  const items = forecast.time.slice(0, 3).map((date, index) => {
    const maxTemp = forecast.temperature_2m_max?.[index] ?? "-";
    const minTemp = forecast.temperature_2m_min?.[index] ?? "-";
    const rain = forecast.precipitation_sum?.[index] ?? 0;
    const riskLabel =
      rain >= 10 || maxTemp >= 32
        ? "Elevated"
        : rain >= 5
        ? "Moderate"
        : "Normal";
    const color =
      riskLabel === "Elevated"
        ? "text-rose-600"
        : riskLabel === "Moderate"
        ? "text-amber-600"
        : "text-emerald-600";
    return `<div class="flex justify-between items-center gap-3"><div><div class="text-sm font-semibold text-slate-800">${new Date(
      date
    ).toLocaleDateString("en-IN", {
      weekday: "short",
      day: "numeric",
      month: "short",
    })}</div><div class="text-sm text-slate-500">${minTemp}° / ${maxTemp}° · ${rain}mm</div></div><span class="text-sm font-bold ${color}">${riskLabel}</span></div>`;
  });
  list.innerHTML = items.join("");
  forecastContainer.classList.remove("hidden");
}

function renderPestAdvisory(d) {
  const advisoryBox = document.getElementById("pestAdvisory");
  const advisoryText = document.getElementById("pestAdvisoryText");
  if (!advisoryBox || !advisoryText) return;
  if (!d?.district_diseases?.length) {
    advisoryBox.classList.add("hidden");
    advisoryText.textContent = "";
    return;
  }

  const topDisease = d.district_diseases[0];
  const humidity = d.weather?.humidity ?? 0;
  const temp = d.weather?.temperature ?? 0;
  const envSignal =
    humidity >= 80 && temp >= 22 && temp <= 30
      ? "high"
      : humidity >= 70
      ? "elevated"
      : "moderate";
  const diseaseName = topDisease?.disease ? topDisease.disease.replace(/_/g, " ") : "Unknown Disease";
  advisoryText.innerHTML = `The top regional advisory is <strong>${diseaseName}</strong> for <strong>${topDisease.crop}</strong> (${
    topDisease.risk_level
  }). Environmental conditions are <strong>${envSignal}</strong> for disease spread. Prioritize scouting and protective action in the next 24 hours.`;
  advisoryBox.classList.remove("hidden");
}

setInterval(() => {
  document.getElementById("clockDisplay").textContent =
    new Date().toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
}, 1000);

function loadDashboard() {
  const rep = document.getElementById("repSelect").value;
  const date = document.getElementById("simDate").value;
  if (!rep) {
    showErrorMessage("Please select a Field Rep", "error");
    return;
  }
  document.getElementById("dashboard").classList.add("hidden");
  document.getElementById("sideInfo").classList.add("hidden");
  document.getElementById("sideWeather").classList.add("hidden");
  document.getElementById("tehsilDetail").classList.add("hidden");
  document.getElementById("loader").classList.remove("hidden");
  showErrorMessage("", "success");
  fetch(`/api/dashboard/${rep}?date=${date}`)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
      return r.json();
    })
    .then((d) => {
      if (!d) throw new Error("Empty response from server");
      document.getElementById("loader").classList.add("hidden");
      currentData = d;
      render(d);
      if (d.lat && d.lng) {
        fetchLiveWeather(d.lat, d.lng).then(updateLiveWeather);
      }
      showErrorMessage("", "success");
    })
    .catch((e) => {
      document.getElementById("loader").classList.add("hidden");
      console.error("Dashboard load error:", e);
      showErrorMessage(`Failed to load dashboard: ${e.message}`, "error");
    });
}

function animateValue(obj, start, end, duration, prefix = "", suffix = "") {
  if (!obj) return;
  let ts = null;
  const step = (t) => {
    if (!ts) ts = t;
    const p = Math.min((t - ts) / duration, 1);
    let v = Math.floor(p * (end - start) + start);
    if (v >= 1000 && !prefix.includes("L")) v = v.toLocaleString();
    obj.innerHTML = prefix + v + suffix;
    if (p < 1) requestAnimationFrame(step);
    else
      obj.innerHTML =
        prefix +
        (end >= 1000 && !prefix.includes("L") ? end.toLocaleString() : end) +
        suffix;
  };
  requestAnimationFrame(step);
}

function render(d) {
  document.getElementById("dashboard").classList.remove("hidden");
  document.getElementById("sideInfo").classList.remove("hidden");
  document.getElementById("sideWeather").classList.remove("hidden");

  // Last updated
  if (d.last_updated) {
    const lu = document.getElementById("lastUpdated");
    lu.textContent =
      "Updated: " +
      new Date(d.last_updated).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
      });
    lu.classList.remove("hidden");
  }

  // Side info
  document.getElementById("iState").textContent = d.state;
  document.getElementById("iDistrict").textContent = d.district;
  animateValue(document.getElementById("iTehsils"), 0, d.tehsils.length, 800);
  const totalG = d.threats.reduce((s, t) => s + t.num_growers, 0);
  animateValue(document.getElementById("iGrowers"), 0, totalG, 800);

  // Weather
  if (d.weather) {
    document.getElementById("wHumidity").textContent = d.weather.humidity + "%";
    document.getElementById("wRain").textContent = d.weather.rainfall + "mm";
    document.getElementById("wTemp").textContent = d.weather.temperature + "°C";
    document.getElementById("wLeaf").textContent = d.weather.leaf_wetness + "h";
  }
  if (d.weather_interpretation) {
    const wi = document.getElementById("weatherInterpretation");
    wi.textContent = "🌡 " + d.weather_interpretation;
    wi.classList.remove("hidden");
  }

  renderPestAdvisory(d);

  // Stats (UX1: smart text when critical=0)
  const sc = document.getElementById("sCritical");
  const sub = document.getElementById("sCriticalSub");
  if (d.stats.critical === 0) {
    sc.textContent = "0";
    sub.classList.remove("hidden");
    if (d.stats.high > 0) sub.textContent = `${d.stats.high} HIGH priority`;
    else if (d.stats.medium > 0)
      sub.textContent = `${d.stats.medium} MEDIUM priority`;
    else sub.textContent = "All clear — monitor weekly";
  } else {
    animateValue(sc, 0, d.stats.critical, 800);
    sub.classList.add("hidden");
  }
  animateValue(document.getElementById("sHigh"), 0, d.stats.high, 800);
  animateValue(
    document.getElementById("sStockouts"),
    0,
    d.stats.stockouts,
    800
  );
  const rev = d.stats.revenue_risk;
  if (rev > 100000)
    animateValue(
      document.getElementById("sRevenue"),
      0,
      Math.round(rev / 100000),
      1200,
      "₹",
      "L"
    );
  else animateValue(document.getElementById("sRevenue"), 0, rev, 1200, "₹");

  const aiConfidence = computeAIConfidence(d);
  const sAIConfidence = document.getElementById("sAIConfidence");
  if (sAIConfidence) sAIConfidence.textContent = `${aiConfidence}%`;

  fetchMLWeights();

  // Map
  const tbody = document.getElementById("heatBody");
  tbody.innerHTML = "";
  if (mapInstance) mapInstance.remove();
  mapInstance = L.map("map", { zoomControl: false }).setView([20, 78], 5);
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    { attribution: "© CartoDB" }
  ).addTo(mapInstance);
  let bounds = [];

  d.threats.forEach((t) => {
    const bc =
      t.threat_level === "CRITICAL"
        ? "badge-critical"
        : t.threat_level === "HIGH"
        ? "badge-high"
        : t.threat_level === "MEDIUM"
        ? "badge-medium"
        : "badge-low";
    const rc = t.threat_level === "CRITICAL" ? "pulse-danger" : "";
    // Score breakdown bar (Feature B)
    const sb = t.score_breakdown || {};
    const total = Math.max(t.heat_score, 1);
    const bw = (sb.bio / total) * 100 || 0,
      iw = (sb.inv / total) * 100 || 0,
      dw = (sb.dig / total) * 100 || 0,
      rw = (sb.rec / total) * 100 || 0,
      pw = (sb.pos / total) * 100 || 0;
    const breakdownBar = `<div class="score-breakdown-bar w-24 flex" title="Bio:${sb.bio} Inv:${sb.inv} Dig:${sb.dig} Rec:${sb.rec} POS:${sb.pos}">
            <div style="width:${bw}%" class="bg-emerald-500"></div>
            <div style="width:${iw}%" class="bg-amber-500"></div>
            <div style="width:${dw}%" class="bg-indigo-500"></div>
            <div style="width:${rw}%" class="bg-sky-500"></div>
            <div style="width:${pw}%" class="bg-rose-400"></div>
        </div><span class="font-display font-bold text-slate-800 text-sm ml-2">${t.heat_score}</span>`;

    tbody.innerHTML += `<tr class="hover:bg-indigo-50/10 transition-colors ${rc} cursor-pointer" onclick="showTehsilDetail('${t.tehsil}')">
            <td class="py-3 font-semibold text-slate-800 text-xs">${t.tehsil}</td>
            <td class="py-3"><div class="flex items-center gap-2">${breakdownBar}</div></td>
            <td class="py-3"><span class="px-2 py-0.5 rounded-full text-sm font-bold ${bc}">${t.threat_level}</span></td>
            <td class="py-3 text-slate-600 text-sm">${t.dominant_crop} / ${t.dominant_stage}</td>
            <td class="py-3 text-sm max-w-[300px] leading-relaxed text-indigo-900 font-medium">${t.explanation}</td>
        </tr>`;

    if (t.lat && t.lng) {
      bounds.push([t.lat, t.lng]);
      const color =
        t.threat_level === "CRITICAL"
          ? "#ef4444"
          : t.threat_level === "HIGH"
          ? "#f59e0b"
          : t.threat_level === "MEDIUM"
          ? "#8b5cf6"
          : "#10b981";
      const sz = Math.round(10 + t.heat_score / 8);
      const anim =
        t.heat_score >= 50 ? "animation:pulse-ring 1.5s infinite;" : "";
      const html = `<div style="background:${color};width:${sz * 2}px;height:${
        sz * 2
      }px;border-radius:50%;border:2.5px solid white;box-shadow:0 2px 10px rgba(0,0,0,.15),0 0 8px ${color};${anim}"></div>`;
      const icon = L.divIcon({
        html,
        className: "",
        iconSize: [sz * 2, sz * 2],
      });
      L.marker([t.lat, t.lng], { icon })
        .addTo(mapInstance)
        .bindPopup(
          `<strong>${t.tehsil}</strong><br>Score: ${t.heat_score} (${t.threat_level})<br><span style="font-size:10px">${t.dominant_crop} / ${t.dominant_stage}</span>`
        )
        .on("click", () => showTehsilDetail(t.tehsil));
    }
  });
  if (bounds.length) mapInstance.fitBounds(bounds, { padding: [30, 30] });

  // Route (Bug 5)
  const rb = document.getElementById("routeBox");
  const rs = document.getElementById("routeSubtitle");
  rb.innerHTML = "";
  if (d.monitoring_only) {
    rs.textContent =
      "No urgent priorities today. Tehsils for monitoring this week:";
    rs.className = "text-sm text-amber-600 font-semibold mb-4";
  } else {
    rs.textContent =
      "TSP-optimized by biological vulnerability, inventory, and recency.";
    rs.className = "text-sm text-slate-500 mb-4 leading-relaxed";
  }
  if (!d.route.length) {
    rb.innerHTML =
      '<p class="text-slate-500 italic text-sm">No tehsils to route.</p>';
  } else {
    d.route.forEach((s, i) => {
      const last = i === d.route.length - 1;
      const tc =
        s.threat_level === "CRITICAL"
          ? "text-red-500"
          : s.threat_level === "HIGH"
          ? "text-amber-600"
          : "text-teal-600";
      rb.innerHTML += `<div class="flex gap-3">
                <div class="flex flex-col items-center"><div class="route-dot mt-1.5"></div>${
                  !last ? '<div class="route-line flex-1"></div>' : ""
                }</div>
                <div class="pb-4 flex-1">
                    <div class="flex items-center gap-2"><span class="font-bold text-sm text-slate-800">Stop ${
                      i + 1
                    }: ${
        s.tehsil
      }</span><span class="font-display font-bold text-xs bg-slate-50 border border-slate-100 px-1.5 py-0.5 rounded ${tc}">${
        s.heat_score
      }</span></div>
                    <div class="text-sm text-indigo-600 font-bold uppercase mt-1">${
                      s.est_time_hours
                    }h (${s.retailers_count} retailers) · Last visit: ${
        s.days_since_visit
      }d ago</div>
                    <div class="text-sm text-slate-600 mt-1">${s.why_visit
                      .map((w) => "• " + w)
                      .join("<br>")}</div>
                    ${
                      s.actions.length
                        ? `<div class="text-sm text-teal-700 bg-teal-50/70 border border-teal-100/50 px-2 py-1 rounded-lg mt-1.5 font-bold inline-flex items-center gap-1"><span class="w-1 h-1 rounded-full bg-teal-500"></span>${s.actions[0]}</div>`
                        : ""
                    }
                </div></div>`;
    });
  }

  // Cost of Inaction (Bug 2)
  const ic = document.getElementById("inactionContent");
  if (d.consequence) {
    const c = d.consequence;
    ic.innerHTML = `
        <div class="flex justify-between py-2 border-b border-indigo-50/50"><span class="text-slate-600 text-sm">Yield Loss</span><span class="font-bold text-red-500">${
          c.yield_loss_pct
        }%</span></div>
        <div class="flex justify-between py-2 border-b border-indigo-50/50"><span class="text-slate-600 text-sm">Revenue Loss</span><span class="font-extrabold text-slate-800">₹${c.revenue_loss.toLocaleString()}</span></div>
        <div class="flex justify-between py-2 border-b border-indigo-50/50"><span class="text-slate-600 text-sm">Fungicide Surge</span><span class="font-bold text-amber-600">${
          c.fungicide_demand_surge
        }</span></div>
        <div class="flex justify-between py-2 border-b border-indigo-50/50"><span class="text-slate-600 text-sm">Stockout In</span><span class="font-bold text-amber-600">${
          c.days_to_stockout
        }d</span></div>
        <div class="flex justify-between py-2"><span class="text-slate-600 text-sm">Churn Risk</span><span class="font-bold px-2 py-0.5 rounded text-sm ${
          c.churn_risk === "CRITICAL"
            ? "badge-critical"
            : c.churn_risk === "HIGH"
            ? "badge-high"
            : "badge-medium"
        }">${c.churn_risk}</span></div>`;
    if (c.baseline_message)
      ic.innerHTML += `<div class="text-sm text-amber-700 bg-amber-50 border border-amber-100 p-2 rounded-lg mt-2 font-medium">${c.baseline_message}</div>`;
  }

  // What-If (Feature D)
  if (d.threats.length && d.threats[0].visit_scenarios) {
    const vs = d.threats[0].visit_scenarios;
    const wc = document.getElementById("whatIfContent");
    wc.innerHTML = `
        <div class="text-sm font-bold text-slate-700 mb-2">${d.threats[0].tehsil}</div>
        <div class="flex justify-between py-1.5 border-b border-indigo-50"><span class="text-slate-600 text-xs">Current risk</span><span class="font-bold text-red-500 text-sm">${vs.current_risk}%</span></div>
        <div class="flex justify-between py-1.5 border-b border-indigo-50"><span class="text-slate-600 text-xs">If visit tomorrow</span><span class="font-bold text-emerald-600 text-sm">${vs.visit_tomorrow}% ↓</span></div>
        <div class="flex justify-between py-1.5 border-b border-indigo-50"><span class="text-slate-600 text-xs">If visit in 3 days</span><span class="font-bold text-amber-600 text-sm">${vs.visit_3days}%</span></div>
        <div class="flex justify-between py-1.5"><span class="text-slate-600 text-xs">If ignored 7 days</span><span class="font-bold text-red-600 text-sm">${vs.ignore_7days}% ↑</span></div>`;
  }

  // Intel Grid
  const ig = document.getElementById("intelGrid");
  ig.innerHTML = "";

  // Disease with context (Bug 8)
  const diseases = d.district_diseases || [];
  if (diseases.length) {
    ig.innerHTML += `<div class="bg-red-50/30 border border-red-100 rounded-xl p-3 shadow-sm">
            <h4 class="text-sm text-slate-500 uppercase font-bold mb-2">District Disease Risk</h4>
            ${diseases
              .map(
                (dd) =>
                  `<div class="text-sm font-bold text-red-500">${dd.disease.replace(
                    /_/g,
                    " "
                  )} <span class="text-sm font-medium text-slate-500">(${
                    dd.crop
                  }, ${dd.risk_level}, ${Math.round(
                    dd.probability * 100
                  )}%)</span></div>`
              )
              .join("")}
            ${
              d.threats[0]?.disease_context
                ? `<div class="text-sm text-slate-600 mt-2 italic">${d.threats[0].disease_context}</div>`
                : ""
            }
        </div>`;
  }

  // Campaign (Bug 4)
  ig.innerHTML += `<div class="bg-indigo-50/30 border border-indigo-100 rounded-xl p-3 shadow-sm">
        <h4 class="text-sm text-slate-500 uppercase font-bold mb-2">Digital Engagement</h4>
        <div class="grid grid-cols-3 gap-2 text-center">
            <div><div class="font-display text-lg font-extrabold text-indigo-600">${d.campaign.open_rate}%</div><div class="text-xs text-slate-500 font-semibold">Open Rate</div></div>
            <div><div class="font-display text-lg font-extrabold text-teal-600">${d.campaign.click_rate}%</div><div class="text-xs text-slate-500 font-semibold">Click Rate</div></div>
            <div><div class="font-display text-lg font-extrabold text-amber-600">${d.campaign.cvr}%</div><div class="text-xs text-slate-500 font-semibold">CVR</div></div>
        </div>
        <div class="text-sm text-slate-500 mt-2">${d.campaign.delivered} delivered · ${d.campaign.opened} opened · ${d.campaign.clicked} clicked</div>
    </div>`;

  // Inventory (Bug 6)
  const allInv = d.threats.flatMap((t) => t.inventory);
  if (allInv.length) {
    ig.innerHTML += `<div class="bg-amber-50/30 border border-amber-100 rounded-xl p-3 shadow-sm">
            <h4 class="text-sm text-slate-500 uppercase font-bold mb-2">Inventory Status</h4>
            ${allInv
              .slice(0, 5)
              .map((i) => {
                const sc =
                  i.status === "CRITICAL"
                    ? "text-red-500 bg-red-50"
                    : i.status === "LOW"
                    ? "text-amber-600 bg-amber-50"
                    : i.status === "MEDIUM"
                    ? "text-indigo-600 bg-indigo-50"
                    : "text-emerald-600 bg-emerald-50";
                return `<div class="flex justify-between items-center py-1"><span class="text-xs text-slate-700 font-semibold">${i.product}</span><span class="text-sm font-bold px-1.5 py-0.5 rounded ${sc}">${i.status} (${i.qty})</span></div>
                <div class="text-xs text-slate-500 mb-1">${i.prediction}</div>`;
              })
              .join("")}
        </div>`;
  }

  // Market
  const mb = document.getElementById("marketBox");
  mb.innerHTML = "";
  for (const [crop, info] of Object.entries(d.market)) {
    const up = info.change > 0;
    mb.innerHTML += `<div class="flex justify-between items-center py-2 border-b border-indigo-50/50">
            <span class="text-sm font-semibold capitalize text-slate-700">${crop}</span>
            <div class="text-right"><span class="font-display font-bold text-slate-800 text-sm">₹${
              info.price
            }</span>
            <span class="text-xs font-bold ml-1.5 ${
              up ? "text-emerald-600 bg-emerald-50" : "text-red-500 bg-red-50"
            } px-1.5 py-0.5 rounded">${up ? "▲" : "▼"}${Math.abs(
      info.change
    ).toFixed(1)}%</span></div>
        </div>`;
  }

  // Chart
  const ctx = document.getElementById("threatChart").getContext("2d");
  if (chartInstance) chartInstance.destroy();
  let grad = ctx.createLinearGradient(0, 0, 0, 240);
  grad.addColorStop(0, "rgba(99,102,241,0.85)");
  grad.addColorStop(1, "rgba(45,212,191,0.3)");
  chartInstance = new Chart(ctx, {
    type: "bar",
    data: {
      labels: d.threats.slice(0, 5).map((t) => t.tehsil.split("_")[0]),
      datasets: [
        {
          label: "Score",
          data: d.threats.slice(0, 5).map((t) => t.heat_score),
          backgroundColor: grad,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: "rgba(99,102,241,1)",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(15,23,42,.95)",
          titleColor: "#a78bfa",
          bodyColor: "#fff",
          padding: 10,
          cornerRadius: 8,
        },
      },
      scales: {
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: "rgba(15,23,42,.05)", drawBorder: false },
          ticks: {
            color: "#475569",
            font: { family: "Inter", weight: "500", size: 11 },
          },
        },
        x: {
          grid: { display: false },
          ticks: {
            color: "#475569",
            font: { family: "Inter", weight: "500", size: 11 },
          },
        },
      },
      animation: { duration: 1200, easing: "easeOutQuart" },
    },
  });
}

function showTehsilDetail(tehsilName) {
  if (!currentData) return;
  const t = currentData.threats.find((x) => x.tehsil === tehsilName);
  if (!t) return;
  const box = document.getElementById("tehsilDetail");
  const content = document.getElementById("tehsilDetailContent");
  box.classList.remove("hidden");
  let html = `<div class="text-sm font-bold text-slate-800 mb-2">${
    t.tehsil
  } <span class="text-sm font-medium ${
    t.threat_level === "CRITICAL"
      ? "text-red-500"
      : t.threat_level === "HIGH"
      ? "text-amber-600"
      : "text-teal-600"
  }">(${t.threat_level})</span></div>`;
  html += `<div class="text-sm text-slate-600 mb-2">${t.explanation}</div>`;
  // Score breakdown
  const sb = t.score_breakdown || {};
  html += `<div class="space-y-1 mb-3">
        <div class="flex justify-between text-xs"><span class="text-emerald-700 font-semibold">Bio Window</span><span>${sb.bio}</span></div>
        <div class="flex justify-between text-xs"><span class="text-amber-700 font-semibold">Inventory</span><span>${sb.inv}</span></div>
        <div class="flex justify-between text-xs"><span class="text-indigo-700 font-semibold">Digital</span><span>${sb.dig}</span></div>
        <div class="flex justify-between text-xs"><span class="text-sky-700 font-semibold">Recency</span><span>${sb.rec}</span></div>
        <div class="flex justify-between text-xs"><span class="text-rose-700 font-semibold">POS</span><span>${sb.pos}</span></div>
    </div>`;
  html += `<div class="text-xs text-slate-500">Last visit: <strong>${t.days_since_visit}d ago</strong> · Growers: ${t.num_growers} · Acres: ${t.total_acres}</div>`;
  if (t.next_action) {
    html += `<div class="text-sm text-slate-600 mt-2">Next best action: <strong>${t.next_action}</strong></div>`;
  }
  // Why not critical (Feature A)
  if (t.why_not_critical && t.why_not_critical.length) {
    html += `<div class="why-not-critical mt-2"><div class="text-xs font-bold text-emerald-700 uppercase mb-1">Why Not Critical</div>`;
    t.why_not_critical.forEach((r) => {
      html += `<div class="text-sm text-slate-600">• ${r}</div>`;
    });
    html += `</div>`;
  }
  content.innerHTML = html;
}

function fetchMLWeights() {
  fetch("/api/ml-weights")
    .then((r) => {
      if (!r.ok) throw new Error(`ML weights failed: ${r.status}`);
      return r.json();
    })
    .then((data) => {
      if (!data || data.status !== "success") return;
      const box = document.getElementById("mlWeightsBox");
      box.innerHTML = "";
      const labels = {
        bio_window: "Crop Biology",
        inv_pressure: "Inventory",
        dig_warmth: "WhatsApp",
        visit_recency: "Visit Recency",
        pos_momentum: "POS Momentum",
      };
      const colors = {
        bio_window: "bg-emerald-500",
        inv_pressure: "bg-amber-500",
        dig_warmth: "bg-indigo-500",
        visit_recency: "bg-sky-500",
        pos_momentum: "bg-rose-400",
      };
      for (const [k, v] of Object.entries(data.weights)) {
        const dv = data.defaults[k];
        box.innerHTML += `<div>
                <div class="flex justify-between text-xs font-bold text-slate-700"><span>${
                  labels[k]
                }</span><span>${(v * 100).toFixed(
          0
        )}% <span class="text-slate-400 font-normal">(default ${(
          dv * 100
        ).toFixed(0)}%)</span></span></div>
                <div class="w-full h-1.5 bg-slate-100 rounded-full mt-1 overflow-hidden"><div class="h-full rounded-full ${
                  colors[k]
                }" style="width:${v * 100}%"></div></div>
            </div>`;
      }
      document.getElementById("mlNote").textContent = data.note || "";
    })
    .catch((e) => {
      console.warn("ML weights fetch failed, using defaults", e);
    });
}

function triggerPestSimulation() {
  const dist = document.getElementById("simDistrict").value;
  if (!dist) {
    showErrorMessage("Please select a district", "error");
    return;
  }
  fetch("/api/simulate-pest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ district: dist }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`Simulation failed: ${r.status}`);
      return r.json();
    })
    .then((data) => {
      if (!data) throw new Error("Empty response");
      if (data.status === "success") {
        document.getElementById("resetPestBtn").classList.remove("hidden");
        const clock = document.getElementById("clockDisplay");
        clock.textContent = "⚠ OUTBREAK ACTIVE";
        clock.className =
          "text-xs font-bold text-red-500 bg-red-100 px-3 py-1.5 rounded-full shadow-inner animate-pulse";
        showErrorMessage("Pest outbreak simulation active", "success");
        loadDashboard();
        setTimeout(() => {
          clock.className =
            "text-xs font-bold text-slate-700 bg-slate-100/80 px-3 py-1.5 rounded-full shadow-inner";
        }, 5000);
      }
    })
    .catch((e) => {
      console.error("Pest simulation error:", e);
      showErrorMessage(`Simulation failed: ${e.message}`, "error");
    });
}

function resetPestSimulation() {
  fetch("/api/simulate-pest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reset: true }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`Reset failed: ${r.status}`);
      return r.json();
    })
    .then((data) => {
      if (!data) throw new Error("Empty response");
      if (data.status === "success") {
        document.getElementById("resetPestBtn").classList.add("hidden");
        showErrorMessage("Pest simulation reset", "success");
        loadDashboard();
      }
    })
    .catch((e) => {
      console.error("Pest reset error:", e);
      showErrorMessage(`Reset failed: ${e.message}`, "error");
    });
}

function exportPriorities() {
  const rep = document.getElementById("repSelect").value;
  const date = document.getElementById("simDate").value;
  if (!rep) {
    alert("Select a rep first.");
    return;
  }
  window.location.href = `/api/export?rep_id=${rep}&date=${date}`;
}
