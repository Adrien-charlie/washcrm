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
//  Fichiers HTML statiques (applications WashCRM)
// ────────────────────────────────────────────────────────────
const fs2 = require('fs');

app.get('/', (req, res) => {
  const filePath = path.join(__dirname, 'APP-GERANT-FINAL.html');
  if (fs2.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.send('<h1>WashCRM</h1><p>Fichier non trouvé. Vérifiez le déploiement.</p>');
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
app.listen(PORT, () => {
  console.log(`\n🚗 AquaStar Webhook Server démarré sur le port ${PORT}`);
  console.log(`   ✅ Webhook  : POST http://localhost:${PORT}/webhook/ingenico`);
  console.log(`   📊 Clients  : GET  http://localhost:${PORT}/api/clients`);
  console.log(`   📈 Stats    : GET  http://localhost:${PORT}/api/stats`);
  console.log(`   ❤️  Santé    : GET  http://localhost:${PORT}/health\n`);
});
