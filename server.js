import * as StellarSdk from "@stellar/stellar-sdk";
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


// دومين موقعك فقط (ضع دومين موقعك هنا)
const allowedOrigins = ["https://spicylibrary.space"];

const corsOptions = {
  origin: function(origin, callback){
    if(!origin) return callback(null, true); // للسيرفر أو أدوات الاختبار
    if(allowedOrigins.indexOf(origin) !== -1){
      callback(null, true); // السماح
    } else {
      callback(new Error("Not allowed by CORS")); // رفض
    }
  }
};

app.use(cors(corsOptions));

app.use(express.json({ limit: "35mb" }));

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

/* ================= STELLAR ================= */
const server = new StellarSdk.Horizon.Server(
  "https://api.mainnet.minepi.com"
);

const APP_SECRET =
  process.env.PI_WALLET_SECRET;

const APP_KEYPAIR =
  StellarSdk.Keypair.fromSecret(
    APP_SECRET
  );

/* ================= PI AUTH MIDDLEWARE ================= */

async function verifyPiUser(req, res) {

  const { accessToken, userUid } = req.body;

  if (!accessToken || !userUid) {
    res.status(400).json({
      error: "Missing data"
    });
    return null;
  }

  const response = await fetch(
    "https://api.minepi.com/v2/me",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    res.status(401).json({
      error: "Invalid access token"
    });
    return null;
  }

  const piUser = await response.json();

  if (piUser.uid !== userUid) {
    res.status(403).json({
      error: "User mismatch"
    });
    return null;
  }

  return piUser;
}

/* ================= ROOT ================= */
app.get("/", (_, res) => res.send("Backend running"));

/* ================= BOOKS ================= */
app.get("/books", async (_, res) => {
  try {

    const snap = await db
      .collection("books")
      .where("approved", "==", true)
      .orderBy("createdAt", "desc")
      .get();

    const books = snap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    res.json({
      success: true,
      books
    });

  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});


// ================= GET SINGLE BOOK =================
app.get("/book", async (req, res) => {
  try {
    const bookId = req.query.id;
    if (!bookId) return res.status(400).json({ success: false, error: "Missing book ID" });

    const doc = await db.collection("books").doc(bookId).get();
   if (!doc.exists) {
  return res.status(404).json({
    success: false,
    error: "Book not found"
  });
}

if (!doc.data().approved) {
  return res.status(404).json({
    success: false,
    error: "Book not found"
  });
}
    res.json({ success: true, book: { id: doc.id, ...doc.data() } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});




/* ================= UPLOAD FILES ================= */
// رفع صورة الغلاف
app.post("/upload-cover", async (req, res) => {
  try {
   const {
  file,
  accessToken,
  userUid
} = req.body;

if (!file || !accessToken || !userUid) {
  return res.status(400).json({
    error: "Missing data"
  });
}

const piUser = await verifyPiUser(req, res);

if (!piUser) return;
    
// حد أقصى 5MB للصور
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const matches = file.match(/^data:(image\/\w+);base64,(.+)$/);

if (!matches) {
  return res.status(400).json({
    success: false,
    error: "Invalid image format"
  });
}

const base64Data = matches[2];

const fileSize = Buffer.byteLength(
  base64Data,
  "base64"
);

if (fileSize > MAX_IMAGE_SIZE) {
  return res.status(400).json({
    error: "Image exceeds 5MB limit"
  });
}
if (!file) {
  return res.status(400).json({
    error: "No file provided"
  });
}

if (!file.startsWith("data:image/")) {
  return res.status(400).json({
    error: "Only images allowed"
  });
}
    // file هنا Base64
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
  const {
  file,
  accessToken,
  userUid
} = req.body;

if (!file || !accessToken || !userUid) {
  return res.status(400).json({
    error: "Missing data"
  });
}

const piUser = await verifyPiUser(req, res);

if (!piUser) return;
    
// حد أقصى 20MB
const MAX_SIZE = 20 * 1024 * 1024;

const matches = file.match(/^data:application\/pdf;base64,(.+)$/);

if (!matches) {
  return res.status(400).json({
    success: false,
    error: "Invalid PDF format"
  });
}

const base64Data = matches[1];

const fileSize = Buffer.byteLength(
  base64Data,
  "base64"
);

if (fileSize > MAX_SIZE) {
  return res.status(400).json({
    error: "PDF exceeds 20MB limit"
  });
}
if (!file) {
  return res.status(400).json({
    error: "No file provided"
  });
}

if (!file.startsWith("data:application/pdf")) {
  return res.status(400).json({
    error: "Only PDF files allowed"
  });
}
    // Base64
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
  title,
  price,
  description,
  language,
  pageCount,
  cover,
  pdf,
  owner,
  ownerUid,
  accessToken
} = req.body;
if (!accessToken) {
  return res.status(401).json({
    error: "Missing access token"
  });
}

const piAuth = await fetch(
  "https://api.minepi.com/v2/me",
  {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  }
);

if (!piAuth.ok) {
  return res.status(401).json({
    error: "Invalid access token"
  });
}

const piUser = await piAuth.json();

if (piUser.uid !== ownerUid) {
  return res.status(403).json({
    error: "User mismatch"
  });
}
    if (!title || !price || !cover || !pdf || !owner || !ownerUid) {
      return res.status(400).json({ error: "Missing data" });
    }
if (
  typeof title !== "string" ||
  typeof owner !== "string" ||
  typeof ownerUid !== "string" ||
  typeof cover !== "string" ||
  typeof pdf !== "string"
) {
  return res.status(400).json({ error: "Invalid data" });
}

if (
  !cover.includes("cloudinary.com") ||
  !pdf.includes("cloudinary.com")
) {
  return res.status(400).json({ error: "Invalid file URLs" });
}

const bookPrice = Number(price);

if (isNaN(bookPrice) || bookPrice <= 0) {
  return res.status(400).json({ error: "Invalid price" });
}
    const doc = await db.collection("books").add({
  title,
  price: bookPrice,
  description: description || "",
  language: language || "",
  pageCount: pageCount || "Unknown",
  cover,
  pdf,
 owner: piUser.username,
  ownerUid: piUser.uid,

      likes: 0,
dislikes: 0,
      
  salesCount: 0,
withdrawableEarnings: 0,
 approved: false,
  reviewed: false,
  reviewMessage: "",
 

  createdAt: Date.now()
});


    await db.doc("stats/platform").set(
  {
    totalBooks:
      admin.firestore.FieldValue.increment(1)
  },
  { merge: true }
);
    
    res.json({ success: true, bookId: doc.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post("/my-notifications", async (req, res) => {
  try {

    const { userUid, accessToken } = req.body;

    if (!userUid || !accessToken) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

   const piUser = await verifyPiUser(req, res);

if (!piUser) return;

    const snap = await db
      .collection("books")
      .where("ownerUid", "==", userUid)
      .where("reviewed", "==", true)
      .get();

    const notifications = snap.docs.map(doc => ({
      id: doc.id,
      title: doc.data().title,
      approved: doc.data().approved,
      reviewMessage:
        doc.data().reviewMessage || ""
    }));

    res.json({
      success: true,
      notifications
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.post("/book-ratings", async (req,res) => {
  try{

    const { bookId, userUid, accessToken } = req.body;

if (!bookId || !userUid || !accessToken) {
  return res.status(400).json({
    success: false,
    error: "Missing data"
  });
}

const piUser = await verifyPiUser(req, res);

if (!piUser) return;
    
    const voteDoc = await db
      .collection("ratings")
      .doc(bookId)
      .collection("votes")
      .doc(userUid)
      .get();

    res.json({
      success:true,
      userVote: voteDoc.exists
        ? voteDoc.data().vote
        : null
    });

  }catch(e){

    res.status(500).json({
      success:false,
      error:e.message
    });

  }
});

/* ================= RATINGS ================= */
app.post("/rate-book", async (req, res) => {
  try {

    const {
  bookId,
  voteType,
  userUid,
  accessToken
} = req.body;

if (
  !bookId ||
  !voteType ||
  !userUid ||
  !accessToken
) {
  return res.status(400).json({
    error: "Missing data"
  });
}

    const piUser = await verifyPiUser(req, res);

if (!piUser) return;

    const voteRef = db
      .collection("ratings")
      .doc(bookId)
      .collection("votes")
      .doc(userUid);

    const oldVote = await voteRef.get();

    const bookRef =
      db.collection("books")
        .doc(bookId);

    await db.runTransaction(async (t) => {

      const bookSnap =
        await t.get(bookRef);

      if (!bookSnap.exists) {
        throw new Error("Book not found");
      }

      let likes =
        bookSnap.data().likes || 0;

      let dislikes =
        bookSnap.data().dislikes || 0;

      if (oldVote.exists) {

        const previous =
          oldVote.data().vote;

        if (previous === "like") likes--;
        if (previous === "dislike") dislikes--;
      }

      if (voteType === "like") likes++;
      if (voteType === "dislike") dislikes++;

      t.update(bookRef, {
        likes,
        dislikes
      });

      t.set(voteRef, {
        vote: voteType,
        votedAt: Date.now()
      });

    });

    res.json({
      success: true
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

/* ================= PAYMENTS ================= */



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

const pendingRef =
  db.collection("pendingPayments")
    .doc(paymentId);

const pendingDoc =
  await pendingRef.get();

if (!pendingDoc.exists) {
  return;
}
      
    await db.runTransaction(async (t) => {
  
const bookSnap = await t.get(bookRef);
const price = Number(bookSnap.data().price || 0);

t.update(bookRef, {
  salesCount: admin.firestore.FieldValue.increment(1),
  withdrawableEarnings:
    admin.firestore.FieldValue.increment(
      price * 0.7
    )
});

  t.set(
    db.collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId),
    { purchasedAt: Date.now() }
  );
});

    await pendingRef.delete();
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

    const { userUid, accessToken } = req.body;

    if (!userUid || !accessToken) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

   const piUser = await verifyPiUser(req, res);

if (!piUser) return;

    const snap = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .orderBy("purchasedAt", "desc")
      .get();

    const books = [];

    for (const d of snap.docs) {
      const b = await db.collection("books").doc(d.id).get();

      if (b.exists) {
        books.push({
          id: b.id,
          ...b.data()
        });
      }
    }

    res.json({
      success: true,
      books
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

/* ================= GET PDF ================= */
app.post("/get-pdf", async (req, res) => {
  try {

    const { bookId, userUid, accessToken } = req.body;

    if (!bookId || !userUid || !accessToken) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

    const piUser = await verifyPiUser(req, res);

if (!piUser) return;

    const p = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .get();

    if (!p.exists) {
      return res.status(403).json({
        error: "Not purchased"
      });
    }

    const book = await db.collection("books").doc(bookId).get();

    if (!book.exists) {
      return res.status(404).json({
        error: "Book not found"
      });
    }

    res.json({
      success: true,
      pdfUrl: book.data().pdf
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

/* ================= SALES ================= */
app.post("/my-sales", async (req, res) => {
  try {

    const { userUid, accessToken } = req.body;

    if (!userUid || !accessToken) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

    const piUser = await verifyPiUser(req, res);

if (!piUser) return;

    const snap = await db
      .collection("books")
      .where("ownerUid", "==", userUid)
      .get();

    const books = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    res.json({
      success: true,
      books
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});
/* ================= RESET SALES ================= */


/* ================= WALLET VALIDATION ================= */
function isValidPiWallet(address) {
  return /^[A-Z2-7]{56}$/.test(address);
}


app.post("/save-wallet", async (req, res) => {

  try {

    const { userUid, walletAddress, accessToken } = req.body;

    if (!accessToken) {
  return res.status(401).json({
    error: "Missing access token"
  });
}

const piUser = await verifyPiUser(req, res);

if (!piUser) return;

    if (!userUid || !walletAddress) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

    if (!isValidPiWallet(walletAddress)) {
      return res.status(400).json({
        error: "Invalid wallet"
      });
    }

    const userRef =
  db.collection("users").doc(userUid);

const userDoc =
  await userRef.get();

if (!userDoc.exists) {

  await db.doc("stats/platform").set({
    totalUsers:
      admin.firestore.FieldValue.increment(1)
  }, { merge:true });

}

await userRef.set(
  { walletAddress },
  { merge:true }
);

    res.json({ success: true });

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }

});


app.post("/get-wallet", async (req, res) => {
  try {

    const { userUid, accessToken } = req.body;

    if (!userUid || !accessToken) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

   const piUser = await verifyPiUser(req, res);

if (!piUser) return;

    const userDoc = await db
      .collection("users")
      .doc(userUid)
      .get();

    res.json({
      success: true,
      walletAddress:
        userDoc.data()?.walletAddress || null
    });

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});


async function sendPi(destination, amount) {

  const sourceAccount =
    await server.loadAccount(
      APP_KEYPAIR.publicKey()
    );

  const fee =
    await server.fetchBaseFee();

  const tx =
    new StellarSdk.TransactionBuilder(
      sourceAccount,
      {
        fee,
        networkPassphrase:
          "Pi Network"
      }
    )
    .addMemo(
  StellarSdk.Memo.text("Withdrawal - Spicy Library")
)
      .addOperation(
        StellarSdk.Operation.payment({
          destination,
          asset:
            StellarSdk.Asset.native(),
          amount: amount.toString()
        })
      )
      .setTimeout(60)
      .build();

  tx.sign(APP_KEYPAIR);

  return await server.submitTransaction(
    tx
  );
}

/* ================= PAYOUT REQUEST ================= */
app.post("/request-payout", async (req, res) => {
  try {

    const { userUid, accessToken } = req.body;

    if (!userUid || !accessToken) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

    // التحقق من هوية المستخدم مع Pi
    const piUser = await verifyPiUser(req, res);

if (!piUser) return;
    const userDoc = await db
      .collection("users")
      .doc(userUid)
      .get();

    if (!userDoc.exists) {
      return res.status(404).json({
        error: "User not found"
      });
    }

    const walletAddress =
      userDoc.data().walletAddress;

    if (!walletAddress) {
      return res.status(400).json({
        error: "Wallet not configured"
      });
    }
// ===== PAYOUT LOCK =====

const payoutLockRef = db
  .collection("payoutLocks")
  .doc(userUid);

const existingLock =
  await payoutLockRef.get();

if (existingLock.exists) {

  const createdAt =
    existingLock.data().createdAt || 0;

  const isLocked =
    Date.now() - createdAt < 3 * 60 * 1000;

  if (isLocked) {
    return res.status(400).json({
      error: "Payout already processing"
    });
  }

  await payoutLockRef.delete();
}

await payoutLockRef.set({
  createdAt: Date.now()
});

// ===== END LOCK =====
    
    // ✅ تحقق محفظة Pi
    

    const booksSnap = await db
      .collection("books")
      .where("ownerUid", "==", userUid)
      .get();

    let totalEarnings = 0;

const booksToReset = [];

booksSnap.forEach(doc => {
  const book = doc.data();
  totalEarnings +=
  Number(book.withdrawableEarnings || 0);

  booksToReset.push(doc.ref);
});

    if (totalEarnings < 5) {
      return res.status(400).json({ error: "Minimum payout is 5 Pi" });
    }

   const paymentResult =
  await sendPi(
    walletAddress,
    totalEarnings.toFixed(2)
  );

// تصفير المبيعات بعد نجاح التحويل فقط
const batch = db.batch();

for (const ref of booksToReset) {
 batch.update(ref, {
  withdrawableEarnings: 0
});
}

await batch.commit();

await db.collection("payouts").add({
  userUid,
  walletAddress,
  amount: Number(
    totalEarnings.toFixed(2)
  ),
  txid: paymentResult.hash,
  paidAt: Date.now()
});

await db.doc("stats/platform").set({
  totalPayouts:
    admin.firestore.FieldValue.increment(
      Number(totalEarnings.toFixed(2))
    )
}, { merge:true });
    
      
  await payoutLockRef.delete();  
    
res.json({
  success: true,
  txid: paymentResult.hash,
  amount: totalEarnings.toFixed(2)
});

  } catch (err) {
    try {
  await db
    .collection("payoutLocks")
    .doc(req.body.userUid)
    .delete();
} catch {}
    console.error("Payout error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


/* ================= START ================= */
// حفظ الدفع كـ pending عند approve
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).json({ error: "missing paymentId" });
  }

  try {

    const paymentInfo = await fetch(
      `${PI_API_URL}/payments/${paymentId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Key ${PI_API_KEY}`
        }
      }
    );

    const paymentData = await paymentInfo.json();

    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;

    // منع شراء نفس الكتاب مرتين
const existingPurchase = await db
  .collection("purchases")
  .doc(userUid)
  .collection("books")
  .doc(bookId)
  .get();

if (existingPurchase.exists) {
  return res.status(400).json({
    error: "Book already purchased"
  });
}
    
    if (!bookId || !userUid) {
      throw new Error("Missing metadata");
    }

    await db.collection("pendingPayments")
      .doc(paymentId)
      .set({
        bookId,
        userUid,
        status: "pending",
        createdAt: Date.now()
      });

    const response = await fetch(
      `${PI_API_URL}/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`
        }
      }
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// إكمال الدفع (مع حذف من pending)
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!paymentId || !txid || !db) return res.status(400).json({ error: "missing data" });
  try {

    const paymentInfo = await fetch(
  `${PI_API_URL}/payments/${paymentId}`,
  {
    method: "GET",
    headers: {
      Authorization: `Key ${PI_API_KEY}`,
      "Content-Type": "application/json"
    }
  }
);

if (!paymentInfo.ok) {
  throw new Error(await paymentInfo.text());
}

const paymentData = await paymentInfo.json();

const bookId = paymentData.metadata?.bookId;
const userUid = paymentData.metadata?.userUid;

if (!bookId || !userUid) {
  throw new Error("Missing payment metadata");
}
    

  
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`,
                "Content-Type": "application/json"
               },
      body: JSON.stringify({ txid })
    });
    if (!response.ok) throw new Error(await response.text());

    const bookRef = db.collection("books").doc(bookId);

const purchaseRef = db
  .collection("purchases")
  .doc(userUid)
  .collection("books")
  .doc(bookId);

await db.runTransaction(async (t) => {

  const existingPurchase =
    await t.get(purchaseRef);

  if (existingPurchase.exists) {
    throw new Error(
      "Book already purchased"
    );
  }

  const bookSnap =
    await t.get(bookRef);

  const price =
    Number(bookSnap.data().price || 0);

 const sellerProfit = price * 0.7;
const platformProfit = price * 0.3;

t.update(bookRef, {
  salesCount:
    admin.firestore.FieldValue.increment(1),

  withdrawableEarnings:
    admin.firestore.FieldValue.increment(
      sellerProfit
    )
});

t.set(
  db.doc("stats/platform"),
  {
    platformProfit:
      admin.firestore.FieldValue.increment(
        platformProfit
      )
  },
  { merge:true }
);

  t.set(purchaseRef, {
    purchasedAt: Date.now()
  });

});

    // حذف الدفع من المعلقين بعد إكماله
    await db.collection("pendingPayments").doc(paymentId).delete();

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب الدفعات المعلقة للمستخدم (للحل التلقائي)
app.get("/pending-payments", async (req, res) => {
  const userUid = String(req.query.userUid || "");
  if (!userUid || !db) return res.status(400).json({ success: false, error: "missing userUid" });
  try {
    const snap = await db.collection("pendingPayments").where("userUid", "==", userUid).get();
    const pendingPayments = snap.docs.map(doc => ({ id: doc.id, bookId: doc.data().bookId }));
    res.json({ success: true, pendingPayments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


app.post("/check-purchase", async (req, res) => {
  try {

    const { userUid, bookId, accessToken } = req.body;

    if (!userUid || !bookId || !accessToken) {
      return res.status(400).json({
        error: "Missing data"
      });
    }

    const piUser = await verifyPiUser(req, res);

if (!piUser) return;
    const purchaseDoc = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .get();

    res.json({
      success: true,
      purchased: purchaseDoc.exists
    });

  } catch (e) {

    res.status(500).json({
      error: e.message
    });

  }
});



app.get("/platform-stats", async (req,res) => {

  try {

    const doc =
      await db.doc("stats/platform").get();

    res.json({
      success:true,
      stats: doc.exists
        ? doc.data()
        : {}
    });

  } catch(e){

    res.status(500).json({
      error:e.message
    });

  }

});



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
















