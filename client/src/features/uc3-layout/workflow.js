async function request(path, { method = "GET" } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The local UC3 controller request failed.");
  return payload;
}

export async function controllerAvailable() {
  try {
    const response = await fetch("/api/uc3/health", { credentials: "same-origin" });
    const payload = await response.json().catch(() => ({}));
    return response.ok && payload.authorized_proxy === true;
  } catch {
    return false;
  }
}

export function startGeneration() {
  return request("/api/uc3/jobs", { method: "POST" });
}

export function getGeneration(jobId) {
  return request(`/api/uc3/jobs/${encodeURIComponent(jobId)}`);
}
