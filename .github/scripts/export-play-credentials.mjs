import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

export async function getPlayCredentials({
  token,
  projectFullName,
  applicationIdentifier,
  request = fetch,
}) {
  if (!token || !projectFullName || !applicationIdentifier) {
    throw new Error(
      "EXPO_TOKEN, MOBILE_PROJECT_FULL_NAME, and MOBILE_APPLICATION_ID are required.",
    );
  }
  async function query(query, variables) {
    const response = await request("https://api.expo.dev/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Expo credential request failed (${response.status}).`);
    const result = await response.json();
    if (result.errors?.length || !result.data)
      throw new Error("Expo could not resolve store credentials.");
    return result.data;
  }
  const data = await query(
    `query StoreCredentials($project: String!, $identifier: String!) {
    app { byFullName(fullName: $project) {
      androidAppCredentials(filter: {applicationIdentifier: $identifier, legacyOnly: false}) {
        applicationIdentifier
        googleServiceAccountKeyForSubmissions { id }
      }
    } }
  }`,
    { project: projectFullName, identifier: applicationIdentifier },
  );
  const credentials = data.app?.byFullName?.androidAppCredentials;
  if (credentials?.length !== 1 || credentials[0].applicationIdentifier !== applicationIdentifier) {
    throw new Error("Expected exactly one matching Android credential set in EAS.");
  }
  const id = credentials[0].googleServiceAccountKeyForSubmissions?.id;
  if (!id) throw new Error("EAS has no Google Play submission key for this application.");
  const key = await query(
    `query StoreKey($id: ID!) {
    googleServiceAccountKey { byId(id: $id) { keyJson } }
  }`,
    { id },
  );
  const json = key.googleServiceAccountKey?.byId?.keyJson;
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("EAS returned an invalid Google Play key.");
  }
  if (parsed.type !== "service_account" || !parsed.private_key || !parsed.client_email) {
    throw new Error("EAS returned an incomplete Google Play service account key.");
  }
  return json;
}

if (process.argv[1] && NodeURL.pathToFileURL(process.argv[1]).href === import.meta.url) {
  const path = process.env.GOOGLE_PLAY_JSON_KEY_PATH;
  if (!path) throw new Error("GOOGLE_PLAY_JSON_KEY_PATH is required.");
  const json = await getPlayCredentials({
    token: process.env.EXPO_TOKEN,
    projectFullName: process.env.MOBILE_PROJECT_FULL_NAME,
    applicationIdentifier: process.env.MOBILE_APPLICATION_ID,
  });
  await NodeFSP.writeFile(path, json, { mode: 0o600, flag: "wx" });
  console.log("Loaded the existing EAS Google Play submission credential.");
}
