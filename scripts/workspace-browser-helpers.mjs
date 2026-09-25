// Browser cases open conversations the way people do: through the Workspace,
// where each conversation is a pane (an iframe of index.html?pane=1). The
// single-conversation page these cases used to drive no longer exists.
export async function signInToWorkspace(page, base, token) {
  // A new computer shows its access key in place of the sign-in form once
  // /api/onboarding/key answers; skip it the way a person would.
  const keyCheck = page.waitForResponse(response => new URL(response.url()).pathname === "/api/onboarding/key");
  await page.goto(base + "/");
  await page.waitForURL(/returnWorkspace=1/);
  const keyInfo = await (await keyCheck).json().catch(() => ({}));
  if (keyInfo.eligible && keyInfo.key) {
    await page.locator("#login-onboarding-skip").click();
    await page.locator("#login-token").waitFor({ state: "visible" });
  }
  await page.locator("#login-token").fill(token);
  await page.locator("#login-form button").click();
  // A browser's first sign-in shows the setup guide; the Workspace follows it.
  // Close is shown at every width (narrow screens hide Skip).
  const guide = page.locator("#onboarding-close");
  const guideShown = await Promise.race([
    guide.waitFor({ state: "visible" }).then(() => true, () => false),
    page.waitForURL(/\/workspace\.html/).then(() => false, () => false),
  ]);
  if (guideShown) await guide.click();
  await workspaceReady(page);
}

export async function workspaceReady(page) {
  await page.waitForFunction(() => (document.getElementById("workspace-host")?.options.length || 0) > 0);
}

// On a phone an open conversation covers the list; going back shows it again.
async function showWorkspaceList(page) {
  if (!await page.evaluate(() => document.body.classList.contains("sidebar-hidden"))) return;
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => !document.body.classList.contains("sidebar-hidden"));
}

async function workspaceRequest(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const response = await fetch(path, body === undefined ? { credentials: "same-origin" }
      : { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(path + " " + response.status + " " + (data.error || ""));
    return data;
  }, { path, body });
}

export const addWorkspaceProject = (page, cwd) => workspaceRequest(page, "/api/workspace/project", { cwd });
export const adoptIntoWorkspace = (page, kind, reference) => workspaceRequest(page, "/api/workspace/adopt", { kind, reference });

// Adds a Pi history to the Workspace by the file name the Host lists it under
// (the Host reports resolved paths, for example /private/var on macOS).
export async function adoptPiHistory(page, fileName) {
  const sessions = (await workspaceRequest(page, "/api/sessions?includeTemporary=1")).sessions || [];
  const row = sessions.find(session => String(session.file || "").split(/[\\/]/).pop() === fileName);
  if (!row) throw new Error("Pi history not listed: " + fileName);
  await adoptIntoWorkspace(page, "pi_history", row.file);
  return row;
}

// The pane's document, for waitForFunction and evaluate as well as locators.
export async function paneFrame(page, title) {
  const frameElement = page.locator("iframe.workspace-frame").and(page.locator("[title^=" + JSON.stringify(title) + "]")).first();
  await frameElement.waitFor({ state: "attached" });
  const frame = await (await frameElement.elementHandle()).contentFrame();
  await frame.waitForLoadState("domcontentloaded");
  return frame;
}

// Opens a conversation from the Workspace sidebar and returns its pane.
export async function openFromSidebar(page, title) {
  await showWorkspaceList(page);
  await page.locator("#workspace-refresh").click();
  const row = page.locator("button.workspace-session").filter({ hasText: title }).first();
  await row.waitFor();
  await row.click();
  return paneFrame(page, title);
}

// Starts a conversation with New session in a project already in the Workspace.
export async function newWorkspaceSession(page, { agentId, name }) {
  await showWorkspaceList(page);
  await page.locator("#workspace-refresh").click();
  await page.locator(".workspace-project-add").first().click();
  const dialog = page.locator("#workspace-dialog-body");
  await dialog.locator("select option[value='" + agentId + "']").waitFor({ state: "attached" });
  await dialog.locator("select").selectOption(agentId);
  await dialog.locator("input").first().fill(name);
  await dialog.locator(".workspace-new-session-create").click();
  await page.locator("#workspace-dialog[open]").waitFor({ state: "detached" }).catch(() => {});
  return paneFrame(page, name);
}
