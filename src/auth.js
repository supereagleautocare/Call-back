// ============================================================================
// Google sign-in (OpenID Connect) + access rules.
//
// Access:  anyone whose email is @ALLOWED_DOMAIN, plus explicit guests.
// Manager: OWNER_EMAIL, or anyone flagged is_manager in app_users.
// Owner:   OWNER_EMAIL (can open the Team & Access admin page).
//
// If GOOGLE_CLIENT_ID isn't set, a local dev login is used so you can run the
// app on your machine before creating Google credentials.
// ============================================================================
import { Issuer, generators } from "openid-client";
import { query } from "./db/index.js";

const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || "").toLowerCase();
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "").toLowerCase();
const BASE_URL = process.env.APP_BASE_URL || "http://localhost:3000";

// Look up (or create) a person and resolve their role flags.
async function resolveUser(email, name) {
  email = email.toLowerCase();
  const isOwner = email === OWNER_EMAIL;
  const inDomain = ALLOWED_DOMAIN && email.endsWith(`@${ALLOWED_DOMAIN}`);

  const existing = await query("SELECT * FROM app_users WHERE email = $1", [email]);
  const row = existing.rows[0];

  // Access = in domain OR an approved guest. Owner always allowed.
  const allowed = isOwner || inDomain || (row && row.is_guest);
  if (!allowed) return null;

  if (row) {
    await query("UPDATE app_users SET last_seen = now(), display_name = COALESCE($2, display_name) WHERE email = $1",
      [email, name]);
  } else {
    await query("INSERT INTO app_users (email, display_name, is_manager, last_seen) VALUES ($1,$2,$3, now())",
      [email, name, isOwner]);
  }

  const isManager = isOwner || (row && row.is_manager) || false;
  return { email, name: name || row?.display_name || email, isManager, isOwner };
}

export async function setupAuth(app) {
  const devMode = !process.env.GOOGLE_CLIENT_ID;

  if (devMode) {
    console.log("⚠ AUTH DEV MODE: no GOOGLE_CLIENT_ID set — using a local test login.");
    app.get("/auth/login", async (req, res) => {
      const email = OWNER_EMAIL || `dev@${ALLOWED_DOMAIN || "example.com"}`;
      req.session.user = await resolveUser(email, "Dev User");
      res.redirect("/");
    });
  } else {
    const issuer = await Issuer.discover("https://accounts.google.com");
    const client = new issuer.Client({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uris: [`${BASE_URL}/auth/callback`],
      response_types: ["code"],
    });

    app.get("/auth/login", (req, res) => {
      req.session.state = generators.state();
      req.session.nonce = generators.nonce();
      res.redirect(client.authorizationUrl({
        scope: "openid email profile",
        state: req.session.state,
        nonce: req.session.nonce,
        hd: ALLOWED_DOMAIN || undefined, // hint Google to the workspace domain
        prompt: "select_account",
      }));
    });

    app.get("/auth/callback", async (req, res) => {
      try {
        const params = client.callbackParams(req);
        const tokenSet = await client.callback(`${BASE_URL}/auth/callback`, params, {
          state: req.session.state,
          nonce: req.session.nonce,
        });
        const claims = tokenSet.claims();
        if (!claims.email_verified) return res.status(403).send(noAccessPage(claims.email));
        const user = await resolveUser(claims.email, claims.name);
        if (!user) return res.status(403).send(noAccessPage(claims.email));
        req.session.user = user;
        res.redirect("/");
      } catch (err) {
        console.error("Auth callback error:", err);
        res.status(500).send("Sign-in failed. Please try again.");
      }
    });
  }

  app.get("/auth/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/auth/login"));
  });
}

// --- Route guards ---------------------------------------------------------
export function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not signed in" });
  return res.redirect("/auth/login");
}
export function requireManager(req, res, next) {
  if (req.session.user?.isManager) return next();
  return res.status(403).json({ error: "managers only" });
}
export function requireOwner(req, res, next) {
  if (req.session.user?.isOwner) return next();
  return res.status(403).json({ error: "owner only" });
}

function noAccessPage(email) {
  return `<!doctype html><meta charset=utf8><title>No access</title>
  <div style="font-family:system-ui;max-width:420px;margin:12vh auto;text-align:center">
    <h1 style="font-size:20px">You don't have access to this app</h1>
    <p style="color:#667">The account <b>${email || ""}</b> isn't on the access list for
    the Callback Tracker. Ask the shop owner to add you.</p>
    <p><a href="/auth/logout">Try a different account</a></p>
  </div>`;
}
