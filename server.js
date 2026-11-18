/**
 * ============================================================
 *  AQUASTAR — Serveur Webhook Ingenico / Worldline
 *  Reçoit les notifications de paiement du TPE et
 *  met à jour automatiquement la base de fidélité.
 * ============================================================
 *
 *  Stack : Node.js + Express
 *  Installation : npm install express crypto
 *  Lancement    : node server.js
 * ============================================================
 */

const express = require('express');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Clé secrète fournie par Worldline/Ingenico dans votre back-office
//    → Remplacez cette valeur par la vraie clé de votre compte
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'VOTRE_CLE_SECRETE_INGENICO';

// ── Fichier JSON servant de base de données légère (remplaçable par PostgreSQL, etc.)
const DB_PATH = path.join(__dirname, 'db.json');

// ────────────────────────────────────────────────────────────
//  Helpers base de données (JSON fichier)
// ────────────────────────────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ clients: {}, transactions: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ────────────────────────────────────────────────────────────
//  Logique fidélité
// ────────────────────────────────────────────────────────────

/**
 * Calcule les points gagnés selon le montant payé.
 * Règle : 1 point par euro (arrondi à l'entier inférieur)
 * Personnalisez cette fonction selon vos offres.
 */
function calculerPoints(montantCentimes) {
  const euros = montantCentimes / 100;
  return Math.floor(euros); // ex: 1250 centimes → 12 points
}

/**
 * Retourne le niveau du client selon ses points cumulés.
 */
function calculerNiveau(points) {
  if (points >= 1000) return 'platinum';
  if (points >= 500)  return 'gold';
  if (points >= 200)  return 'silver';
  return 'bronze';
}

/**
 * Met à jour ou crée un client dans la DB et crédite ses points.
 * Retourne les données client mises à jour.
 */
function crediterClient(db, cardToken, montantCentimes, transactionId) {
  const pointsGagnes = calculerPoints(montantCentimes);
  const now = new Date().toISOString();

  // Crée le profil client s'il n'existe pas encore
  if (!db.clients[cardToken]) {
    db.clients[cardToken] = {
      cardToken,
      points:       0,
      totalLavages: 0,
      niveau:       'bronze',
      createdAt:    now,
      lastSeenAt:   now,
    };
    console.log(`[FIDÉLITÉ] Nouveau client enregistré : ${cardToken}`);
  }

  const client = db.clients[cardToken];

  // Vérifie les doublons (idempotence)
  const dejaTraite = db.transactions.some(t => t.transactionId === transactionId);
  if (dejaTraite) {
    console.log(`[WEBHOOK] Transaction ${transactionId} déjà traitée — ignorée`);
    return { client, pointsGagnes: 0, doublon: true };
  }

  // Crédite les points
  client.points       += pointsGagnes;
  client.totalLavages += 1;
  client.niveau        = calculerNiveau(client.points);
  client.lastSeenAt    = now;

  // Enregistre la transaction
  db.transactions.push({
    transactionId,
    cardToken,
    montantCentimes,
    pointsGagnes,
    date: now,
  });

  return { client, pointsGagnes, doublon: false };
}

// ────────────────────────────────────────────────────────────
//  Vérification de signature Worldline (HMAC-SHA256)
// ────────────────────────────────────────────────────────────

/**
 * Worldline signe chaque webhook avec HMAC-SHA256.
 * On vérifie que la requête vient bien d'eux et non d'un tiers.
 *
 * En-tête attendu : X-GCS-Signature  (ou X-Worldline-Signature selon votre contrat)
 */
function verifierSignature(body, signatureHeader) {
  if (!signatureHeader) return false;
  const hmac     = crypto.createHmac('sha256', WEBHOOK_SECRET);
  const expected = hmac.update(body).digest('base64');
  // Comparaison sécurisée (protège contre timing attacks)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader)
    );
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────
//  Middlewares
// ────────────────────────────────────────────────────────────

// On garde le body brut pour la vérification de signature
app.use('/webhook/ingenico', express.raw({ type: 'application/json' }));
app.use(express.json()); // Pour les autres routes

// ────────────────────────────────────────────────────────────
//  Route principale : réception du webhook Ingenico/Worldline
// ────────────────────────────────────────────────────────────

app.post('/webhook/ingenico', (req, res) => {
  const signature = req.headers['x-gcs-signature'] || req.headers['x-worldline-signature'];
  const rawBody   = req.body; // Buffer (grâce à express.raw)

  // 1. Vérification de la signature
  if (!verifierSignature(rawBody, signature)) {
    console.warn('[SÉCURITÉ] Signature invalide — requête rejetée');
    return res.status(401).json({ error: 'Signature invalide' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  console.log('[WEBHOOK] Reçu :', JSON.stringify(payload, null, 2));

  // 2. On ne traite que les paiements réussis
  //    Worldline envoie un type "payment.paid" ou status "PAID"
  const type   = payload.type   || '';
  const status = payload.payment?.status || payload.status || '';

  if (type !== 'payment.paid' && status !== 'PAID') {
    console.log(`[WEBHOOK] Événement ignoré (type: ${type}, status: ${status})`);
    return res.status(200).json({ message: 'Événement non traité' });
  }

  // 3. Extraction des données de la transaction
  //    Structure typique Worldline Connect / Ingenico ePayments
  const transactionId   = payload.payment?.id || payload.id;
  const montantCentimes = payload.payment?.paymentOutput?.amountOfMoney?.amount
                       || payload.amount
                       || 0;

  // Le token de carte (identifiant anonyme du client)
  // Worldline fournit un "token" ou "cardToken" après tokenisation
  const cardToken = payload.payment?.paymentOutput?.cardPaymentMethodSpecificOutput?.token
                 || payload.payment?.token
                 || payload.token
                 || null;

  if (!transactionId || !montantCentimes || !cardToken) {
    console.warn('[WEBHOOK] Données manquantes — transaction ignorée', { transactionId, montantCentimes, cardToken });
    return res.status(200).json({ message: 'Données insuffisantes pour fidélité' });
  }

  // 4. Mise à jour de la fidélité
  const db = loadDB();
  const { client, pointsGagnes, doublon } = crediterClient(db, cardToken, montantCentimes, transactionId);

  if (!doublon) {
    saveDB(db);
    console.log(`[FIDÉLITÉ] +${pointsGagnes} pts → ${cardToken} | Total: ${client.points} pts | Niveau: ${client.niveau}`);
  }

  // 5. Réponse 200 obligatoire (Worldline relance sinon)
  return res.status(200).json({
    message:       doublon ? 'Doublon ignoré' : 'Points crédités',
    pointsGagnes,
    totalPoints:   client.points,
    niveau:        client.niveau,
    totalLavages:  client.totalLavages,
  });
});

// ────────────────────────────────────────────────────────────
//  API interne pour l'application de fidélité
// ────────────────────────────────────────────────────────────

/** GET /api/client/:cardToken — Récupère le profil d'un client */
app.get('/api/client/:cardToken', (req, res) => {
  const db     = loadDB();
  const client = db.clients[req.params.cardToken];
  if (!client) return res.status(404).json({ error: 'Client introuvable' });
  res.json(client);
});

/** GET /api/clients — Liste tous les clients (pour le tableau de bord gérant) */
app.get('/api/clients', (req, res) => {
  const db      = loadDB();
  const clients = Object.values(db.clients).sort((a, b) => b.points - a.points);
  res.json({ total: clients.length, clients });
});

/** GET /api/stats — Statistiques globales */
app.get('/api/stats', (req, res) => {
  const db           = loadDB();
  const clients      = Object.values(db.clients);
  const transactions = db.transactions;

  const maintenant  = new Date();
  const debut_mois  = new Date(maintenant.getFullYear(), maintenant.getMonth(), 1);

  const lavagesMois = transactions.filter(t => new Date(t.date) >= debut_mois).length;
  const caTotal     = transactions.reduce((s, t) => s + t.montantCentimes, 0);

  res.json({
    totalClients:   clients.length,
    totalLavages:   transactions.length,
    lavagesCeMois:  lavagesMois,
    chiffreAffaires: (caTotal / 100).toFixed(2) + ' €',
    repartitionNiveaux: {
      bronze:   clients.filter(c => c.niveau === 'bronze').length,
      silver:   clients.filter(c => c.niveau === 'silver').length,
      gold:     clients.filter(c => c.niveau === 'gold').length,
      platinum: clients.filter(c => c.niveau === 'platinum').length,
    }
  });
});

/**
 * POST /api/promo/envoyer — Simule l'envoi d'un code promo
 * (à connecter à votre prestataire SMS/email : Brevo, Mailchimp, etc.)
 */
app.post('/api/promo/envoyer', express.json(), (req, res) => {
  const { cible, code, message } = req.body;

  const db      = loadDB();
  const clients = Object.values(db.clients);

  let destinataires = clients;
  if (cible === 'gold')     destinataires = clients.filter(c => c.niveau === 'gold' || c.niveau === 'platinum');
  if (cible === 'silver')   destinataires = clients.filter(c => c.niveau === 'silver');
  if (cible === 'bronze')   destinataires = clients.filter(c => c.niveau === 'bronze');
  if (cible === 'inactive') {
    const il_y_a_30j = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    destinataires = clients.filter(c => new Date(c.lastSeenAt) < il_y_a_30j);
  }

  // TODO : ici vous brancheriez Brevo / Mailchimp / Twilio pour l'envoi réel
  console.log(`[PROMO] Code ${code} → ${destinataires.length} client(s) | Message: ${message}`);

  res.json({
    success:        true,
    code,
    nbDestinataires: destinataires.length,
    cible,
  });
});


// ────────────────────────────────────────────────────────────
//  NOTIFICATIONS PUSH (état de la station, annonces…)
//  Variables Railway requises :
//    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, GERANT_CODE
// ────────────────────────────────────────────────────────────
app.set('trust proxy', 1);

const webpush = (() => { try { return require('web-push'); } catch (e) { return null; } })();
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const GERANT_CODE   = process.env.GERANT_CODE       || '';
const SUPABASE_URL  = process.env.SUPABASE_URL || 'https://hpucsjjbbklqqvpljbgr.supabase.co';
const SUPABASE_KEY  = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhwdWNzampiYmtscXF2cGxqYmdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyMTk4MDUsImV4cCI6MjA5Mjc5NTgwNX0.3cFAvaL0TIXzO1N3lu59hLrf_8td5ADC5a0gGbXKmgY';

const pushActif = !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE && GERANT_CODE);
if (pushActif) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://washcrm-production.up.railway.app', VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('[PUSH] Désactivé — il manque web-push ou VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / GERANT_CODE');
}

const sbHeaders = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };

// Anti force brute sur le code gérant : 5 erreurs => blocage 15 min par IP
const echecs = new Map();
function codeValide(req) {
  const ip = req.ip || 'inconnu';
  const e = echecs.get(ip) || { n: 0, until: 0 };
  if (e.until > Date.now()) return { ok: false, bloque: true };
  const fourni = String(req.headers['x-gerant-code'] || '');
  const h = s => crypto.createHash('sha256').update(s).digest();
  const ok = crypto.timingSafeEqual(h(fourni), h(GERANT_CODE));
  if (ok) { echecs.delete(ip); return { ok: true }; }
  e.n += 1;
  if (e.n >= 5) { e.until = Date.now() + 15 * 60 * 1000; e.n = 0; }
  echecs.set(ip, e);
  return { ok: false };
}


/** Envoie un payload à une liste d'abonnements ; supprime ceux qui sont expirés. */
async function envoyerPush(subs, payloadObj) {
  const payload = JSON.stringify(payloadObj);
  let envoyes = 0, echoues = 0; const aSupprimer = [];
  const LOT = 25;
  for (let i = 0; i < subs.length; i += LOT) {
    await Promise.all(subs.slice(i, i + LOT).map(async s => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
        envoyes++;
      } catch (err) {
        echoues++;
        if (err.statusCode === 404 || err.statusCode === 410) aSupprimer.push(s.id); // abonnement expiré
        else console.warn('[PUSH] Échec', err.statusCode || err.message);
      }
    }));
  }
  if (aSupprimer.length) {
    try {
      await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?id=in.(' + aSupprimer.join(',') + ')', { method: 'DELETE', headers: sbHeaders });
    } catch (e) { console.warn('[PUSH] Nettoyage impossible :', e.message); }
  }
  return { envoyes, echoues, aSupprimer };
}

/** GET /api/push/key — clé publique pour l'abonnement côté client */
app.get('/api/push/key', (req, res) => {
  if (!pushActif) return res.status(503).json({ error: 'Push non configuré' });
  res.json({ publicKey: VAPID_PUBLIC });
});

/** GET /api/push/status — le gérant vérifie que le push est opérationnel (protégé) */
app.get('/api/push/status', (req, res) => {
  if (!pushActif) return res.status(503).json({ error: 'Push non configuré' });
  const c = codeValide(req);
  if (!c.ok) return res.status(c.bloque ? 429 : 401).json({ error: c.bloque ? 'Trop d\'essais' : 'Code invalide' });
  res.json({ ok: true });
});

/** POST /api/push/notify — envoie une notification à tous les abonnés (protégé par le code gérant) */
app.post('/api/push/notify', async (req, res) => {
  if (!pushActif) return res.status(503).json({ error: 'Push non configuré' });
  const c = codeValide(req);
  if (!c.ok) return res.status(c.bloque ? 429 : 401).json({ error: c.bloque ? 'Trop d\'essais, réessayez plus tard' : 'Code invalide' });

  const titre   = String((req.body && req.body.titre)   || '').slice(0, 80).trim();
  const message = String((req.body && req.body.message) || '').slice(0, 200).trim();
  const tag     = String((req.body && req.body.tag)     || 'station').slice(0, 40);
  if (!titre) return res.status(400).json({ error: 'Titre manquant' });

  let subs = [];
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth', { headers: sbHeaders });
    if (!r.ok) throw new Error('Supabase ' + r.status);
    subs = await r.json();
  } catch (e) {
    console.error('[PUSH] Lecture abonnés impossible :', e.message);
    return res.status(502).json({ error: 'Lecture des abonnés impossible' });
  }

  let urlCible = String((req.body && req.body.url) || '/client');
  if (!(urlCible.startsWith('/') || urlCible.startsWith('https://'))) urlCible = '/client';
  const r = await envoyerPush(subs, { title: titre, body: message, url: urlCible, tag });
  const envoyes = r.envoyes, echoues = r.echoues, aSupprimer = r.aSupprimer;
  console.log('[PUSH] "' + titre + '" -> ' + envoyes + ' envoyé(s), ' + echoues + ' échec(s), ' + aSupprimer.length + ' supprimé(s)');
  res.json({ envoyes, echoues, supprimes: aSupprimer.length, total: subs.length });
});


// ────────────────────────────────────────────────────────────
//  DEMANDE D'AVIS GOOGLE — 30 min après « Valider ma présence »
//  Une demande maximum par client et par 30 jours, sans contrepartie.
//  Variables facultatives : AVIS_GOOGLE_URL, AVIS_DELAI_MIN, AVIS_INTERVALLE_S
// ────────────────────────────────────────────────────────────
const AVIS_URL      = process.env.AVIS_GOOGLE_URL || 'https://g.page/r/CVLZ7U-YsMqdEAE/review';
const AVIS_DELAI_MS = (parseInt(process.env.AVIS_DELAI_MIN, 10) || 30) * 60 * 1000;
const AVIS_PAUSE_MS = 30 * 24 * 3600 * 1000;
const AVIS_LIMITE_MS = 12 * 3600 * 1000; // au-delà de 12 h, on ne relance plus
let avisEnCours = false;

async function sbJson(chemin, options) {
  const r = await fetch(SUPABASE_URL + chemin, Object.assign({ headers: sbHeaders }, options || {}));
  if (!r.ok) throw new Error('Supabase ' + r.status + ' ' + chemin.split('?')[0]);
  return (options && options.method === 'PATCH') ? null : r.json();
}

async function traiterDemandesAvis() {
  if (!pushActif || avisEnCours) return;
  avisEnCours = true;
  try {
    const maintenant = Date.now();
    const avant = encodeURIComponent(new Date(maintenant - AVIS_DELAI_MS).toISOString());
    const apres = encodeURIComponent(new Date(maintenant - AVIS_LIMITE_MS).toISOString());
    const scans = await sbJson('/rest/v1/scans?select=id,client_id,heure_scan&avis_statut=is.null&heure_scan=lt.' + avant + '&heure_scan=gt.' + apres + '&order=heure_scan.asc&limit=100');
    if (!scans.length) return;

    const parClient = new Map(); const sansClient = [];
    for (const s of scans) {
      if (!s.client_id) { sansClient.push(s.id); continue; }
      if (!parClient.has(s.client_id)) parClient.set(s.client_id, []);
      parClient.get(s.client_id).push(s.id);
    }
    const marquer = (ids, statut) => sbJson('/rest/v1/scans?id=in.(' + ids.join(',') + ')', { method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, sbHeaders), body: JSON.stringify({ avis_statut: statut }) });
    if (sansClient.length) await marquer(sansClient, 'ignore');

    for (const [clientId, ids] of parClient) {
      let statut = 'ignore';
      try {
        const depuis = encodeURIComponent(new Date(maintenant - AVIS_PAUSE_MS).toISOString());
        const recents = await sbJson('/rest/v1/scans?select=id&client_id=eq.' + clientId + '&avis_statut=eq.envoye&heure_scan=gt.' + depuis + '&limit=1');
        if (!recents.length) {
          const subs = await sbJson('/rest/v1/push_subscriptions?select=id,endpoint,p256dh,auth&client_id=eq.' + clientId);
          if (subs.length) {
            const r = await envoyerPush(subs, { title: '⭐ Comment était votre lavage ?', body: 'Votre avis nous aide beaucoup : 30 secondes sur Google.', url: AVIS_URL, tag: 'avis' });
            if (r.envoyes > 0) statut = 'envoye';
          }
        }
      } catch (e) { console.warn('[AVIS] Client', clientId, e.message); continue; } // on réessaiera au prochain passage
      await marquer(ids, statut);
      console.log('[AVIS] client ' + clientId + ' -> ' + statut);
    }
  } catch (e) {
    console.warn('[AVIS] Traitement impossible :', e.message);
  } finally {
    avisEnCours = false;
  }
}
if (pushActif) setInterval(traiterDemandesAvis, (parseInt(process.env.AVIS_INTERVALLE_S, 10) || 60) * 1000);

// ────────────────────────────────────────────────────────────
//  Fichiers HTML statiques (applications WashCRM)
// ────────────────────────────────────────────────────────────
const fs2 = require('fs');

app.get('/manifest.json', (req, res) => {
  const filePath = path.join(__dirname, 'manifest.json');
  if (fs2.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/manifest+json');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'manifest.json non trouvé' });
  }
});

app.get('/sw.js', (req, res) => {
  const filePath = path.join(__dirname, 'sw.js');
  if (fs2.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'sw.js non trouvé' });
  }
});

app.get('/icon-192.png', (req, res) => {
  const filePath = path.join(__dirname, 'icon-192.png');
  if (fs2.existsSync(filePath)) {
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(filePath);
  } else {
    res.status(404).send('icon-192.png non trouvé');
  }
});

app.get('/icon-512.png', (req, res) => {
  const filePath = path.join(__dirname, 'icon-512.png');
  if (fs2.existsSync(filePath)) {
    res.setHeader('Content-Type', 'image/png');
    res.sendFile(filePath);
  } else {
    res.status(404).send('icon-512.png non trouvé');
  }
});


app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'APP-GERANT-FINAL.html');
  if (fs2.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.send('<h1>WashCRM</h1><p>Fichier non trouvé.</p>');
  }
});

app.get('/gerant', (req, res) => {
  const filePath = path.join(__dirname, 'APP-GERANT-FINAL.html');
  if (fs2.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.send('<h1>APP-GERANT-FINAL.html non trouvé</h1><p>Fichiers présents : ' + fs2.readdirSync(__dirname).join(', ') + '</p>');
  }
});

app.get('/client', (req, res) => {
  const filePath = path.join(__dirname, 'APP-CLIENT-FINAL.html');
  if (fs2.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.send('<h1>APP-CLIENT-FINAL.html non trouvé</h1><p>Fichiers présents : ' + fs2.readdirSync(__dirname).join(', ') + '</p>');
  }
});


app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ────────────────────────────────────────────────────────────
//  Démarrage
// ────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚗 WashCRM Server démarré sur le port ${PORT}`);
  console.log(`   ✅ Gérant  : GET http://0.0.0.0:${PORT}/gerant`);
  console.log(`   📱 Client  : GET http://0.0.0.0:${PORT}/client`);
  console.log(`   ❤️  Santé   : GET http://0.0.0.0:${PORT}/health\n`);
});
