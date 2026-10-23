const STRUCTURED_BIN_ID = /^(?<zone>[^-]+)-A(?<aisle>\d+)-R(?<rack>\d+)-L(?<level>\d+)-F(?<face>\d+)-B(?<bin>\d+)$/i;

/** Derive display-only hierarchy without changing the persisted bin ID. */
export function parseStructuredBinId(binId, expectedZoneId = null) {
  const match = STRUCTURED_BIN_ID.exec(String(binId || "").trim());
  if (!match?.groups) {
    return {
      aisleNumber: null,
      rackNumber: null,
      shelfLevel: null,
      positionZ: null,
      faceNumber: null,
      binPosition: null,
      mappingStatus: "unparseable",
      mappingIssue: "Bin ID does not match Zone-Aisle-Rack-Level-Face-Bin format",
    };
  }

  const parsedZoneId = match.groups.zone.toUpperCase();
  const expected = expectedZoneId ? String(expectedZoneId).toUpperCase() : null;
  const zoneMismatch = expected && parsedZoneId !== expected;
  const level = Number(match.groups.level);
  return {
    aisleNumber: Number(match.groups.aisle),
    rackNumber: Number(match.groups.rack),
    shelfLevel: `L${match.groups.level.padStart(2, "0")}`,
    positionZ: level,
    faceNumber: Number(match.groups.face),
    binPosition: `B${match.groups.bin.padStart(2, "0")}`,
    isPickFace:
      Number(match.groups.aisle) === 1 &&
      Number(match.groups.rack) === 1 &&
      level === 1 &&
      Number(match.groups.face) === 1 &&
      Number(match.groups.bin) === 1,
    mappingStatus: zoneMismatch ? "zone-mismatch" : "mapped",
    mappingIssue: zoneMismatch ? `ID zone ${parsedZoneId} does not match database zone ${expected}` : null,
  };
}
