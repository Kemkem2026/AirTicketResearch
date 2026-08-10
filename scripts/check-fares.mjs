// 3種類の探索を行うスクリプト:
//
// 1. scopes: 「地域」×「航空連合」の範囲内で最安値の行き先を発見
// 2. carrierScopes: 指定した航空会社群(連合単位 or 個別指定)ごとに、
//    地域別(サブリージョン等)にどこが一番安いかを発見
// 3. homeCarrierScopes: JAL/ANAなど自社について、東京発の最安路線TOP Nを発見
//
// 往復検索: config.oneWay=false の場合、period.beginningOfPeriod(往路月)と
// period.returnMonth(復路目安月)の両方をAPIに渡し、往復の組み合わせ最安値を取得する。
//
// データソース: Travelpayouts Data API
//   - v1/prices/cheap (destination="-" で出発地から全方面への最安値一覧を取得)
//   - data/en/alliances.json (航空会社→アライアンス対応。Travelpayouts側のデータなので自動的に最新に追従)
//   - data/en/cities.json (都市IATAコード→国コード)
// 地域(大陸/サブリージョン)は data/geo.json を使用(npmのworld-countriesから生成した静的データ)
//
// 制約: このAPIは経由地/乗り継ぎ空港の情報を返さないため、
// 「航空会社がどのハブ経由か」は判別できない。航空会社(マーケティングキャリア)単位が最小粒度。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const TOKEN = process.env.TRAVELPAYOUTS_TOKEN;
if (!TOKEN) {
  console.error("環境変数 TRAVELPAYOUTS_TOKEN が設定されていません。");
  process.exit(1);
}

const headers = { "X-Access-Token": TOKEN };

async function fetchJson(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  return res.json();
}

// --- 参照データの取得 ---

function normalizeAllianceName(name) {
  const n = name.toLowerCase().replace(/\s+/g, "");
  if (n.includes("oneworld")) return "oneworld";
  if (n.includes("skyteam")) return "skyteam";
  if (n.includes("star")) return "staralliance";
  return n;
}

async function loadAllianceData() {
  const json = await fetchJson("https://api.travelpayouts.com/data/en/alliances.json");
  const rawByAlliance = {};
  const airlineToAlliance = {};
  for (const entry of json) {
    const alliance = normalizeAllianceName(entry.name);
    rawByAlliance[alliance] = (entry.airlines || []).map((c) => c.toUpperCase());
    for (const code of entry.airlines || []) {
      airlineToAlliance[code.toUpperCase()] = alliance;
    }
  }
  return { rawByAlliance, airlineToAlliance };
}

async function loadCityCountryMap() {
  const json = await fetchJson("https://api.travelpayouts.com/data/en/cities.json");
  const countryOf = {};
  const nameOf = {};
  for (const c of json) {
    countryOf[c.code] = c.country_code;
    nameOf[c.code] = c.name;
  }
  return { countryOf, nameOf };
}

async function loadGeo() {
  const raw = await readFile(path.join(ROOT, "data", "geo.json"), "utf-8");
  return JSON.parse(raw);
}

// --- 運賃取得(行き先ごとに全候補を保持) ---

async function fetchAllCandidatesFromOrigin(origin, config) {
  const params = new URLSearchParams({
    origin,
    destination: "-",
    currency: config.currency,
  });
  if (config.period?.beginningOfPeriod) {
    params.set("depart_date", config.period.beginningOfPeriod.slice(0, 7));
  }
  if (config.oneWay === false && config.period?.returnMonth) {
    params.set("return_date", config.period.returnMonth.slice(0, 7));
  }

  const url = `https://api.travelpayouts.com/v1/prices/cheap?${params.toString()}`;
  const json = await fetchJson(url);
  if (!json.success || !json.data) return [];

  const results = [];
  for (const [destination, entries] of Object.entries(json.data)) {
    for (const [rank, entry] of Object.entries(entries)) {
      results.push({
        origin,
        destination,
        rank: Number(rank),
        price: entry.price,
        airline: entry.airline,
        departureAt: entry.departure_at,
        returnAt: entry.return_at ?? null,
      });
    }
  }
  return results;
}

// --- 地域/連合フィルタ ---

function matchesRegion(countryCode, region, geo, customGroups) {
  if (!countryCode) return false;
  if (region.type === "subregion") {
    const info = geo[countryCode];
    return !!info && region.value.includes(info.subregion);
  }
  if (region.type === "region") {
    const info = geo[countryCode];
    return !!info && region.value.includes(info.region);
  }
  if (region.type === "customGroup") {
    const group = customGroups[region.value];
    return !!group && group.countries.includes(countryCode);
  }
  return false;
}

async function main() {
  const config = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf-8"));

  console.log("参照データを取得中...");
  const [allianceData, cityData, geo] = await Promise.all([
    loadAllianceData(),
    loadCityCountryMap(),
    loadGeo(),
  ]);

  console.log("運賃データを取得中...");
  let allCandidates = [];
  for (const origin of config.origins) {
    console.log(`  origin: ${origin}`);
    const candidates = await fetchAllCandidatesFromOrigin(origin, config);
    allCandidates = allCandidates.concat(candidates);
  }

  const enriched = allCandidates.map((f) => {
    const countryCode = cityData.countryOf[f.destination] ?? null;
    const geoInfo = countryCode ? geo[countryCode] : null;
    return {
      ...f,
      cityName: cityData.nameOf[f.destination] ?? f.destination,
      countryCode,
      countryName: geoInfo?.name ?? null,
      region: geoInfo?.region ?? null,
      subregion: geoInfo?.subregion ?? null,
      alliance: allianceData.airlineToAlliance[f.airline] || "other",
    };
  });

  // ===== 1. scopes: 地域 x 連合 =====
  const scopeResults = (config.scopes || []).map((scope) => {
    const matched = enriched
      .filter((f) => matchesRegion(f.countryCode, scope.region, geo, config.customGroups))
      .filter((f) => scope.alliances.includes(f.alliance));

    const cheapestByDestination = {};
    for (const f of matched) {
      if (!cheapestByDestination[f.destination] || f.price < cheapestByDestination[f.destination].price) {
        cheapestByDestination[f.destination] = f;
      }
    }

    const filtered = Object.values(cheapestByDestination)
      .sort((a, b) => a.price - b.price)
      .slice(0, config.resultsPerScope ?? 8);

    return {
      label: scope.label,
      region: scope.region,
      alliances: scope.alliances,
      results: filtered.map((f) => ({
        destination: f.destination,
        cityName: f.cityName,
        countryName: f.countryName,
        origin: f.origin,
        price: f.price,
        airline: f.airline,
        alliance: f.alliance,
        departureAt: f.departureAt,
        returnAt: f.returnAt,
      })),
    };
  });

  // ===== 2. carrierScopes: 航空会社群 x 地域別最安値 =====
  const carrierScopeResults = [];
  for (const cs of config.carrierScopes || []) {
    let targetAirlines = [];
    let airlineLabels = {};

    if (cs.mode === "airlines") {
      targetAirlines = Object.keys(cs.airlines || {});
      airlineLabels = cs.airlines || {};
    } else {
      targetAirlines = (allianceData.rawByAlliance[cs.alliance] || []).filter(
        (code) => !(cs.excludeAirlines || []).includes(code)
      );
    }

    const perAirline = [];
    for (const airline of targetAirlines) {
      const airlineCandidates = enriched.filter((f) => f.airline === airline);
      if (airlineCandidates.length === 0) continue;

      const byGroup = {};
      for (const f of airlineCandidates) {
        const groupKey = cs.groupBy === "region" ? f.region : f.subregion;
        if (!groupKey) continue;
        if (!byGroup[groupKey] || f.price < byGroup[groupKey].price) {
          byGroup[groupKey] = f;
        }
      }

      const groupResults = Object.entries(byGroup)
        .map(([groupKey, f]) => ({
          group: groupKey,
          destination: f.destination,
          cityName: f.cityName,
          countryName: f.countryName,
          origin: f.origin,
          price: f.price,
          departureAt: f.departureAt,
          returnAt: f.returnAt,
        }))
        .sort((a, b) => a.price - b.price);

      if (groupResults.length > 0) {
        perAirline.push({
          airline,
          airlineName: airlineLabels[airline] || null,
          groupResults,
        });
      }
    }

    carrierScopeResults.push({
      label: cs.label,
      mode: cs.mode || "alliance",
      alliance: cs.alliance || null,
      groupBy: cs.groupBy,
      airlines: perAirline,
    });
  }

  // ===== 3. homeCarrierScopes: JAL/ANAなど自社の東京発最安路線TOP N =====
  const homeCarrierResults = [];
    for (const hc of config.homeCarrierScopes || []) {
    let candidates = enriched.filter((f) => f.airline === hc.airline);
    if (hc.excludeDomestic) {
      candidates = candidates.filter((f) => f.countryCode !== "JP");
    }


    const cheapestByDestination = {};
    for (const f of candidates) {
      if (!cheapestByDestination[f.destination] || f.price < cheapestByDestination[f.destination].price) {
        cheapestByDestination[f.destination] = f;
      }
    }

    const top = Object.values(cheapestByDestination)
      .sort((a, b) => a.price - b.price)
      .slice(0, hc.top ?? 5);

    homeCarrierResults.push({
      label: hc.label,
      airline: hc.airline,
      results: top.map((f) => ({
        destination: f.destination,
        cityName: f.cityName,
        countryName: f.countryName,
        origin: f.origin,
        price: f.price,
        departureAt: f.departureAt,
        returnAt: f.returnAt,
      })),
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    currency: config.currency,
    origins: config.origins,
    oneWay: config.oneWay,
    period: config.period,
    scopes: scopeResults,
    carrierScopes: carrierScopeResults,
    homeCarrierScopes: homeCarrierResults,
  };

  await mkdir(path.join(ROOT, "data"), { recursive: true });
  await writeFile(path.join(ROOT, "data", "results.json"), JSON.stringify(output, null, 2));

  console.log("完了: data/results.json を更新しました");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
