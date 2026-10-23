/** Map Supabase rows → view models. Column names match sql/schema-contract.md. */

export function mapProductRelationship(row) {
  return {
    id: row.relationshipid,
    warehouseid: row.warehouseid,
    consequent: row.consequent_productid,
    consequentName: row.consequentName || row.consequent_productid,
    antecedents: row.antecedents || [],
    antecedentNames: row.antecedentNames || row.antecedents || [],
    itemsetsize: row.itemsetsize,
    support: Number(row.support ?? 0),
    confidence: Number(row.confidence ?? 0),
    lift: Number(row.lift ?? 0),
    strength: row.strength || "Weak",
    ordercount: row.ordercount,
    rulesource: row.rulesource,
    runid: row.runid,
  };
}

export function mapReplenishment(row) {
  return {
    id: row.recommendationid,
    warehouseid: row.warehouseid,
    productid: row.productid,
    productname: row.productname || row.productid,
    qtyonhand: Number(row.qtyonhand ?? 0),
    reorderpoint: Number(row.reorderpoint ?? 0),
    recommendedorderqty: Number(row.recommendedorderqty ?? 0),
    status: row.status || row.inventorystatus || "Available",
    fulfillmentstatus: row.fulfillmentstatus,
    copickskus: row.copickskus,
    reason: row.recommendationreason,
    runid: row.runid,
  };
}

export function mapLayoutRecommendation(row) {
  const pct = Number(row.distanceimprovementpct ?? 0);
  return {
    id: row.movefieldid,
    warehouseid: row.warehouseid,
    productid: row.productid,
    productname: row.productname || row.productid,
    velocityclass: row.velocityclass,
    movedirection: row.movedirection,
    reason: row.reason,
    distanceimprovementm: Number(row.distanceimprovementm ?? 0),
    timesavedseconds: row.timesavedseconds === null || row.timesavedseconds === undefined ? null : Number(row.timesavedseconds),
    distanceimprovementpct: pct,
    improvementLabel: `${Math.round(pct * 100)}%`,
    priority: row.priority || "Medium",
    avgdailydemand: Number(row.avgdailydemand ?? 0),
    lift: Number(row.lift ?? 0),
    currentbin: row.currentbin,
    recommendedbin: row.recommendedbin,
    runid: row.runid,
  };
}
