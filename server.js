import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";
import cloudinary from 'cloudinary';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const PiNetwork = require('pi-backend').default;

// ← Mainnet: المعاملان الإضافيان مطلوبان
const piSDK = new PiNetwork(
  process.env.PI_API_KEY,
  process.env.PI_WALLET_SECRET,
  "https://api.mainnet.minepi.com",
  "Pi Network"
);

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

const allowedOrigins = ["https://spicylibrary.space"];
const corsOptions = {
  origin: function(origin, callback){
    if(!origin) return callback(null, true);
    if(allowedOrigins.indexOf(origin) !== -1){
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  }
};
app.use(cors(corsOptions));
app.use(express.json({ limit: "35mb" }));

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});
const db = admin.firestore();

const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_URL = "https://api.minepi.com/v2";

/* ================= PI AUTH MIDDLEWARE ================= */
async function verifyPiUser(req, res) {
  const { accessToken, userUid } = req.body;
  if (!accessToken || !userUid) {
    res.status(400).json({ error: "Missing data" });
    return null;
  }
  const response = await fetch("https://api.minepi.com/v2/me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) {
    res.status(401).json({ error: "Invalid access token" });
    return null;
  }
  const piUser = await response.json();
  if (piUser.uid !== userUid) {
    res.status(403).json({ error: "User mismatch" });
    return null;
  }
  return piUser;
}

app.get("/", (_, res) => res.send("Backend running"));

/* =============================================
 *  BOOKS ENDPOINTS
 * ============================================= */
app.get("/books", async (_, res) => {
  try {
    const snap = await db.collection("books").where("approved","==",true).orderBy("createdAt","desc").get();
    const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, books });
  } catch(e){ res.status(500).json({ success: false, error: e.message }); }
});

app.get("/book", async (req, res) => {
  try {
    const bookId = req.query.id;
    if (!bookId) return res.status(400).json({ success: false, error: "Missing book ID" });
    const doc = await db.collection("books").doc(bookId).get();
    if (!doc.exists || !doc.data().approved) return res.status(404).json({ success: false, error: "Book not found" });
    res.set({ "Cache-Control": "no-store", "Pragma": "no-cache", "Expires": "0" });
    res.json({ success: true, book: { id: doc.id, ...doc.data() } });
  } catch(e){ res.status(500).json({ success: false, error: e.message }); }
});

app.post("/upload-cover", async (req, res) => {
  try {
    const { file, accessToken, userUid } = req.body;
    if (!file || !accessToken || !userUid) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const matches = file.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: "Invalid image format" });
    if (Buffer.byteLength(matches[2], "base64") > 5 * 1024 * 1024) return res.status(400).json({ error: "Image >5MB" });
    const result = await cloudinary.v2.uploader.upload(file, { folder: "books/covers" });
    res.json({ success: true, url: result.secure_url });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/upload-pdf", async (req, res) => {
  try {
    const { file, accessToken, userUid } = req.body;
    if (!file || !accessToken || !userUid) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const matches = file.match(/^data:application\/pdf;base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: "Invalid PDF format" });
    if (Buffer.byteLength(matches[1], "base64") > 20 * 1024 * 1024) return res.status(400).json({ error: "PDF >20MB" });
    const result = await cloudinary.v2.uploader.upload(file, {
      folder: "books/pdfs", resource_type: "raw", public_id: `book_${Date.now()}`, format: "pdf"
    });
    res.json({ success: true, url: result.secure_url });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/save-book", async (req, res) => {
  try {
    const { title, price, description, language, pageCount, cover, pdf, owner, ownerUid, accessToken } = req.body;
    if (!accessToken) return res.status(401).json({ error: "Missing token" });
    const piAuth = await fetch("https://api.minepi.com/v2/me", { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!piAuth.ok) return res.status(401).json({ error: "Invalid token" });
    const piUser = await piAuth.json();
    if (piUser.uid !== ownerUid) return res.status(403).json({ error: "User mismatch" });
    if (!title || !price || !cover || !pdf || !owner || !ownerUid) return res.status(400).json({ error: "Missing data" });
    if (!cover.includes("cloudinary.com") || !pdf.includes("cloudinary.com")) return res.status(400).json({ error: "Invalid URLs" });
    const bookPrice = Number(price);
    if (isNaN(bookPrice) || bookPrice <= 0) return res.status(400).json({ error: "Invalid price" });
    const doc = await db.collection("books").add({
      title, price: bookPrice, description: description || "", language: language || "",
      pageCount: pageCount || "Unknown", cover, pdf,
      owner: piUser.username, ownerUid: piUser.uid,
      likes: 0, dislikes: 0, salesCount: 0, withdrawableEarnings: 0,
      approved: false, reviewed: false, reviewMessage: "", createdAt: Date.now()
    });
    await db.doc("stats/platform").set({ totalBooks: admin.firestore.FieldValue.increment(1) }, { merge: true });
    res.json({ success: true, bookId: doc.id });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/my-notifications", async (req, res) => {
  try {
    const { userUid, accessToken } = req.body;
    if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const snap = await db.collection("books").where("ownerUid","==",userUid).where("reviewed","==",true).get();
    const notifications = snap.docs.map(doc => ({
      id: doc.id, title: doc.data().title, approved: doc.data().approved, reviewMessage: doc.data().reviewMessage || ""
    }));
    res.json({ success: true, notifications });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/book-ratings", async (req, res) => {
  try {
    const { bookId, userUid, accessToken } = req.body;
    if (!bookId || !userUid || !accessToken) return res.status(400).json({ success: false, error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const voteDoc = await db.collection("ratings").doc(bookId).collection("votes").doc(userUid).get();
    res.json({ success: true, userVote: voteDoc.exists ? voteDoc.data().vote : null });
  } catch(e){ res.status(500).json({ success: false, error: e.message }); }
});

app.post("/rate-book", async (req, res) => {
  try {
    const { bookId, voteType, userUid, accessToken } = req.body;
    if (!bookId || !voteType || !userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const voteRef = db.collection("ratings").doc(bookId).collection("votes").doc(userUid);
    const oldVote = await voteRef.get();
    const bookRef = db.collection("books").doc(bookId);
    await db.runTransaction(async (t) => {
      const bookSnap = await t.get(bookRef);
      if (!bookSnap.exists) throw new Error("Book not found");
      let likes = bookSnap.data().likes || 0;
      let dislikes = bookSnap.data().dislikes || 0;
      if (oldVote.exists) {
        if (oldVote.data().vote === "like") likes--;
        if (oldVote.data().vote === "dislike") dislikes--;
      }
      if (voteType === "like") likes++;
      if (voteType === "dislike") dislikes++;
      t.update(bookRef, { likes, dislikes });
      t.set(voteRef, { vote: voteType, votedAt: Date.now() });
    });
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/add-comment", async (req, res) => {
  try {
    const { bookId, userUid, accessToken, text } = req.body;
    if (!bookId || !userUid || !accessToken || !text) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const commentRef = db.collection("books").doc(bookId).collection("comments").doc(userUid);
    if ((await commentRef.get()).exists) return res.status(400).json({ success: false, error: "Already commented" });
    await commentRef.set({ userUid, username: piUser.username, text, createdAt: Date.now() });
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get("/comments", async (req, res) => {
  try {
    const bookId = req.query.bookId;
    if (!bookId) return res.status(400).json({ error: "Missing bookId" });
    const snap = await db.collection("books").doc(bookId).collection("comments").orderBy("createdAt","desc").get();
    res.json({ success: true, comments: snap.docs.map(d => d.data()) });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get("/has-comment", async (req, res) => {
  try {
    const { bookId, userUid } = req.query;
    if (!bookId || !userUid) return res.status(400).json({ success: false });
    const doc = await db.collection("books").doc(bookId).collection("comments").doc(userUid).get();
    res.json({ success: true, commented: doc.exists });
  } catch(e){ res.status(500).json({ success: false }); }
});

/* ================= PURCHASE PAYMENTS (U2A) ================= */
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "missing paymentId" });
  try {
    const paymentInfo = await fetch(`${PI_API_URL}/payments/${paymentId}`, { headers: { Authorization: `Key ${PI_API_KEY}` } });
    const paymentData = await paymentInfo.json();
    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;
    if (!bookId || !userUid) throw new Error("Missing metadata");
    const existing = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (existing.exists) return res.status(400).json({ error: "Already purchased" });
    await db.collection("pendingPayments").doc(paymentId).set({ bookId, userUid, status: "pending", createdAt: Date.now() });
    const response = await fetch(`${PI_API_URL}/payments/${paymentId}/approve`, { method: "POST", headers: { Authorization: `Key ${PI_API_KEY}` } });
    if (!response.ok) throw new Error(await response.text());
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!paymentId || !txid) return res.status(400).json({ error: "missing data" });
  try {
    const paymentInfo = await fetch(`${PI_API_URL}/payments/${paymentId}`, { headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" } });
    const paymentData = await paymentInfo.json();
    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;
    if (!bookId || !userUid) throw new Error("Missing metadata");
    const response = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ txid })
    });
    if (!response.ok) throw new Error(await response.text());
    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);
    await db.runTransaction(async (t) => {
      if ((await t.get(purchaseRef)).exists) throw new Error("Already purchased");
      const bookSnap = await t.get(bookRef);
      const price = Number(bookSnap.data().price || 0);
      t.update(bookRef, {
        salesCount: admin.firestore.FieldValue.increment(1),
        withdrawableEarnings: admin.firestore.FieldValue.increment(price * 0.7)
      });
      t.set(db.doc("stats/platform"), { platformProfit: admin.firestore.FieldValue.increment(price * 0.3) }, { merge: true });
      t.set(purchaseRef, { purchasedAt: Date.now() });
    });
    await db.collection("pendingPayments").doc(paymentId).delete();
    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/my-purchases", async (req, res) => {
  try {
    const { userUid, accessToken } = req.body;
    if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const snap = await db.collection("purchases").doc(userUid).collection("books").orderBy("purchasedAt","desc").get();
    const books = [];
    for (const d of snap.docs) {
      const b = await db.collection("books").doc(d.id).get();
      if (b.exists) books.push({ id: b.id, ...b.data() });
    }
    res.json({ success: true, books });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/get-pdf", async (req, res) => {
  try {
    const { bookId, userUid, accessToken } = req.body;
    if (!bookId || !userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const p = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (!p.exists) return res.status(403).json({ error: "Not purchased" });
    const book = await db.collection("books").doc(bookId).get();
    if (!book.exists) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, pdfUrl: book.data().pdf });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/my-sales", async (req, res) => {
  try {
    const { userUid, accessToken } = req.body;
    if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const snap = await db.collection("books").where("ownerUid","==",userUid).get();
    res.json({ success: true, books: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/check-purchase", async (req, res) => {
  try {
    const { userUid, bookId, accessToken } = req.body;
    if (!userUid || !bookId || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const p = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    res.json({ success: true, purchased: p.exists });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.get("/pending-payments", async (req, res) => {
  const userUid = String(req.query.userUid || "");
  if (!userUid) return res.status(400).json({ success: false, error: "missing userUid" });
  try {
    const snap = await db.collection("pendingPayments").where("userUid","==",userUid).get();
    res.json({ success: true, pendingPayments: snap.docs.map(d => ({ id: d.id, bookId: d.data().bookId })) });
  } catch(e){ res.status(500).json({ success: false, error: e.message }); }
});

/* ================= WALLET ================= */
function isValidPiWallet(address) {
  return /^[A-Z2-7]{56}$/.test(address);
}

app.post("/save-wallet", async (req, res) => {
  try {
    const { userUid, walletAddress, accessToken } = req.body;
    if (!userUid || !walletAddress || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    if (!isValidPiWallet(walletAddress)) return res.status(400).json({ error: "Invalid wallet" });
    await db.collection("users").doc(userUid).set({ walletAddress }, { merge: true });
    res.json({ success: true });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

app.post("/get-wallet", async (req, res) => {
  try {
    const { userUid, accessToken } = req.body;
    if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const userDoc = await db.collection("users").doc(userUid).get();
    res.json({ success: true, walletAddress: userDoc.data()?.walletAddress || null });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

/* ================================================================
 *  PAYOUT — A2U على Mainnet عبر pi-backend الرسمي
 * ================================================================ */

/* ── إلغاء الدفعات المعلقة ── */
async function cancelAllIncompletePi() {
  try {
    const payments = await piSDK.getIncompleteServerPayments();
    for (const p of payments) {
      await piSDK.cancelPayment(p.identifier);
      console.log(`Cancelled: ${p.identifier}`);
      if (p.metadata?.userUid) {
        await db.collection("payoutLocks").doc(p.metadata.userUid).delete().catch(()=>{});
      }
    }
  } catch(e) { console.warn("cancelAllIncompletePi error:", e.message); }
}

app.post("/request-payout", async (req, res) => {
  const { userUid, accessToken, walletAddress } = req.body;
  if (!userUid || !accessToken) 
    return res.status(400).json({ success: false, error: "Missing data" });

  const piUser = await verifyPiUser(req, res);
  if (!piUser) return;

  // 1. إلغاء الدفعات المعلقة
  await cancelAllIncompletePi();

  // 2. قفل لمنع طلبين متزامنين
  const lockRef = db.collection("payoutLocks").doc(piUser.uid);
  const lock = await lockRef.get();
  if (lock.exists && Date.now() - lock.data().createdAt < 3 * 60 * 1000) {
    return res.status(400).json({ 
      success: false, 
      error: "Payout already processing, please wait 3 minutes" 
    });
  }
  await lockRef.delete().catch(()=>{});
  await lockRef.set({ createdAt: Date.now() });

  // 3. حساب الأرباح
  const booksSnap = await db.collection("books")
    .where("ownerUid", "==", piUser.uid).get();
  let total = 0;
  booksSnap.forEach(d => { total += Number(d.data().withdrawableEarnings || 0); });

  if (total < 5) {
    await lockRef.delete();
    return res.status(400).json({ success: false, error: "Minimum payout is 5 Pi" });
  }
  const amount = parseFloat(total.toFixed(7));

  // 4. حفظ عنوان المحفظة إذا أُرسل (للرجوع إليه لاحقاً)
  if (walletAddress) {
    await db.collection("users").doc(piUser.uid)
      .set({ walletAddress }, { merge: true })
      .catch(()=>{});
  }

  let paymentId = null;
  try {
    // 5. إنشاء الدفعة A2U
    paymentId = await piSDK.createPayment({
      amount,
      memo: "Spicy Library - Author Earnings Payout",
      metadata: { 
        type: "payout", 
        userUid: piUser.uid, 
        username: piUser.username 
      },
      uid: piUser.uid
    });

    console.log("Payment created:", paymentId);

    // 6. إرسال على البلوكشين
    const txid = await piSDK.submitPayment(paymentId);
    console.log("Submitted txid:", txid);

    // 7. إكمال الدفعة
    const completed = await piSDK.completePayment(paymentId, txid);
    console.log("Payout completed:", completed.status);

    // 8. تصفير الأرباح
    const batch = db.batch();
    booksSnap.forEach(d => batch.update(d.ref, { withdrawableEarnings: 0 }));
    await batch.commit();

    await db.collection("payouts").add({ 
      userUid: piUser.uid, amount, txid, paymentId, paidAt: Date.now() 
    });
    await db.doc("stats/platform").set(
      { totalPayouts: admin.firestore.FieldValue.increment(amount) },
      { merge: true }
    );
    await lockRef.delete().catch(()=>{});

    return res.json({ success: true, txid, amount });

  } catch(err) {
    console.error("Payout error:", err.message);
    await lockRef.delete().catch(()=>{});
    if (paymentId) {
      try { 
        await piSDK.cancelPayment(paymentId); 
      } catch(ce) { 
        console.warn("Cancel failed:", ce.message); 
      }
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= PLATFORM STATS ================= */
app.get("/platform-stats", async (req, res) => {
  try {
    const statsDoc = await db.doc("stats/platform").get();
    const stats = statsDoc.exists ? statsDoc.data() : {};
    const [a, b] = await Promise.all([
      db.collection("books").where("approved","==",true).get(),
      db.collection("books").where("reviewed","==",true).get()
    ]);
    stats.approvedBooks = a.size;
    stats.reviewedBooks = b.size;
    await db.doc("stats/platform").set({ approvedBooks: a.size, reviewedBooks: b.size }, { merge: true });
    res.json({ success: true, stats });
  } catch(e){ res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
