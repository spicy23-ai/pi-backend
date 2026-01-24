import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";
import cloudinary from 'cloudinary';

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});
/* ================= APP ================= */
const app = express();
app.use(cors({
  origin: "https://spicy23-ai.github.io",  // ضع هنا رابط موقعك بالضبط
  methods: ["GET", "POST"]                 // فقط هذه الطرق مسموح بها
}));

app.use(express.json({ limit: "10mb" }));

/* ================= FIREBASE ================= */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});
const db = admin.firestore();

/* ================= PI ================= */
const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_URL = "https://api.minepi.com/v2";

/* ================= ROOT ================= */
app.get("/", (_, res) => res.send("Backend running"));

/* ================= BOOKS ================= */
app.get("/books", async (_, res) => {
  try {
    const snap = await db.collection("books").orderBy("createdAt", "desc").get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, books });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ================= UPLOAD FILES ================= */
// رفع صورة الغلاف
app.post("/upload-cover", async (req, res) => {
  try {
    const { file } = req.body; // file هنا Base64
    if (!file) return res.status(400).json({ error: "No file provided" });

    const result = await cloudinary.v2.uploader.upload(file, {
      folder: "books/covers"
    });

    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// رفع PDF
app.post("/upload-pdf", async (req, res) => {
  try {
    const { file } = req.body; // Base64
    if (!file) return res.status(400).json({ error: "No file provided" });

    const result = await cloudinary.v2.uploader.upload(file, {
  folder: "books/pdfs",
  resource_type: "raw",
  public_id: `book_${Date.now()}`, // اسم الملف
  format: "pdf"                    // ← هذا هو الحل
});


    res.json({ success: true, url: result.secure_url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});


/* ================= SAVE BOOK ================= */
app.post("/save-book", async (req, res) => {
  try {
    const {
      title, price, description, language, pageCount,
      cover, pdf, owner, ownerUid
    } = req.body;

    if (!title || !price || !cover || !pdf || !owner || !ownerUid) {
      return res.status(400).json({ error: "Missing data" });
    }

    const doc = await db.collection("books").add({
      title,
      price: Number(price),
      description: description || "",
      language: language || "",
      pageCount: pageCount || "Unknown",
      cover,
      pdf,
      owner,
      ownerUid,
      salesCount: 0,
      createdAt: Date.now()
    });

    res.json({ success: true, bookId: doc.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= RATINGS ================= */
app.post("/rate-book", async (req, res) => {
  try {
    const { bookId, voteType, userUid } = req.body;
    if (!bookId || !voteType || !userUid) {
      return res.status(400).json({ error: "Missing data" });
    }

    await db
      .collection("ratings")
      .doc(bookId)
      .collection("votes")
      .doc(userUid)
      .set({ vote: voteType, votedAt: Date.now() });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/book-ratings", async (req, res) => {
  try {
    const { bookId, userUid } = req.body;
    const snap = await db
      .collection("ratings")
      .doc(bookId)
      .collection("votes")
      .get();

    let likes = 0, dislikes = 0, userVote = null;
    snap.forEach(d => {
      if (d.data().vote === "like") likes++;
      if (d.data().vote === "dislike") dislikes++;
      if (d.id === userUid) userVote = d.data().vote;
    });

    res.json({ success: true, likes, dislikes, userVote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= PAYMENTS ================= */

app.post("/approve-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: "Missing paymentId" });

    // جلب بيانات الدفع من Pi
    const paymentRes = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!paymentRes.ok) throw new Error(await paymentRes.text());
    const paymentData = await paymentRes.json();

    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;

    if (!bookId || !userUid) return res.status(400).json({ error: "Missing metadata in Pi payment" });

    // حفظ الدفع كـ pending
    await db.collection("pendingPayments").doc(paymentId).set({
      bookId,
      userUid,
      status: "pending",
      createdAt: Date.now()
    });

    // الموافقة على الدفع
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!r.ok) throw new Error(await r.text());
    res.json({ success: true });

  } catch (e) {
    console.error("Approve error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


app.post("/complete-payment", async (req, res) => {
  try {
    const { paymentId, txid } = req.body;
    if (!paymentId || !txid) return res.status(400).json({ error: "Missing payment data" });

    // جلب الدفع من pending
    const pendingSnap = await db.collection("pendingPayments").doc(paymentId).get();
    if (!pendingSnap.exists) return res.status(400).json({ error: "Pending payment not found" });

    const { bookId, userUid } = pendingSnap.data();

    // إكمال الدفع على Pi
    const completeRes = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid })
    });

    if (!completeRes.ok) throw new Error(await completeRes.text());

    // تحديث Firestore
    const bookRef = db.collection("books").doc(bookId);
    await db.runTransaction(async (t) => {
      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(db.collection("purchases").doc(userUid).collection("books").doc(bookId), { purchasedAt: Date.now() });
    });

    // حذف الدفع من pending
    await db.collection("pendingPayments").doc(paymentId).delete();

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });

  } catch (e) {
    console.error("Complete payment error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// 🔹 معالجة الدفعات المعلقة (اختياري – لكنه آمن)
async function handlePendingPayment(paymentId) {
  try {
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!r.ok) throw new Error(await r.text());
    const paymentData = await r.json();

    if (!paymentData.txid) return;

    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;

    if (!bookId || !userUid) return;

    await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid: paymentData.txid })
    });

    const bookRef = db.collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      t.update(bookRef, {
        salesCount: admin.firestore.FieldValue.increment(1)
      });

      t.set(
        db.collection("purchases")
          .doc(userUid)
          .collection("books")
          .doc(bookId),
        { purchasedAt: Date.now() }
      );
    });

    console.log("✅ Pending payment resolved:", paymentId);

  } catch (e) {
    console.log("⚠️ Pending resolve failed:", e.message);
  }
}

app.post("/resolve-pending", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) {
      return res.status(400).json({ error: "Missing paymentId" });
    }

    await handlePendingPayment(paymentId);
    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


/* ================= PURCHASES ================= */
app.post("/my-purchases", async (req, res) => {
  try {
    const { userUid } = req.body;
    const snap = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .get();

    const books = [];
    for (const d of snap.docs) {
      const b = await db.collection("books").doc(d.id).get();
      if (b.exists) books.push({ id: b.id, ...b.data() });
    }

    res.json({ success: true, books });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= GET PDF ================= */
app.post("/get-pdf", async (req, res) => {
  try {
    const { bookId, userUid } = req.body;

    const p = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .get();

    if (!p.exists) return res.status(403).json({ error: "Not purchased" });

    const book = await db.collection("books").doc(bookId).get();
    res.json({ success: true, pdfUrl: book.data().pdf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= SALES ================= */
app.post("/my-sales", async (req, res) => {
  try {
    const { username } = req.body;
    const snap = await db.collection("books").where("owner", "==", username).get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, books });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= RESET SALES ================= */
app.post("/reset-sales", async (req, res) => {
  try {
    const { username } = req.body;
    const snap = await db.collection("books").where("owner", "==", username).get();
    const batch = db.batch();
    snap.forEach(d => batch.update(d.ref, { salesCount: 0 }));
    await batch.commit();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
/* ================= PAYOUT REQUEST ================= */
app.post("/request-payout", async (req, res) => {
  try {
    const { username, walletAddress } = req.body;
    if (!username || !walletAddress) {
      return res.status(400).json({ error: "Missing data" });
    }

    const userRef = db.collection("users").doc(username);
    const userSnap = await userRef.get();

    // 🔹 جلب كتب المستخدم
    const booksSnap = await db.collection("books")
      .where("owner", "==", username)
      .get();

    let totalEarnings = 0;
    const batch = db.batch();

    booksSnap.forEach(doc => {
      const book = doc.data();
      const sales = book.salesCount || 0;
      const profit = sales * book.price * 0.7;
      totalEarnings += profit;

      // تصفير المبيعات
      batch.update(doc.ref, { salesCount: 0 });
    });

    if (totalEarnings < 5) {
      return res.status(400).json({ error: "Minimum payout is 5 Pi" });
    }

    // 🔹 إنشاء طلب payout
    await db.collection("payout_requests").add({
      username,
      walletAddress,
      amount: Number(totalEarnings.toFixed(2)),
      status: "pending",
      requestedAt: Date.now(),
      approvedAt: null
    });

    // 🔹 تحديث المستخدم فقط لإظهار آخر طلب
    await userRef.set({
      lastPayoutAt: Date.now(),
      lastPayoutAmount: Number(totalEarnings.toFixed(2))
    }, { merge: true });

    await batch.commit();

    res.json({
      success: true,
      amount: Number(totalEarnings.toFixed(2))
    });

  } catch (err) {
    console.error("Payout error:", err);
    res.status(500).json({ error: "Server error" });
  }
});




const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));













