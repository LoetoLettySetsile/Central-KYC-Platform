// Required modules
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const router = express.Router();
const dayjs = require('dayjs'); // Optional: for formatting dates
const pdfParse = require('pdf-parse');
module.exports = router;
const Tesseract = require('tesseract.js');
const { fromPath } = require('pdf2pic'); // convert PDF to image
const ExcelJS = require('exceljs');

const app = express();
app.use(express.urlencoded({ extended: true }));


// utils/auditLogger.js or top of index.js
const logAudit = async ({ db, userId, action, targetType, targetId = null, details = null }) => {
  try {
    await db.execute(
      `INSERT INTO Audit_Log (user_id, action, target_type, target_id, timestamp, details)
       VALUES (?, ?, ?, ?, NOW(), ?)`,
      [userId, action, targetType, targetId, details]
    );
  } catch (err) {
    console.error('🔴 Failed to write audit log:', err);
  }
};

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(session({
  secret: 'secretkey123',
  resave: false,
  saveUninitialized: true
}));

// Setup multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueName = Date.now() + '-' + file.originalname;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// MySQL connection
let db;
(async () => {
  db = await mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Loeto#2020',
    database: 'Central_KYC_db'
  });
  console.log('✅ Connected to MySQL database');
})();

async function extractOCRText(imagePath) {
  try {
    const result = await Tesseract.recognize(imagePath, 'eng', { logger: m => console.log(m) });
    return result.data.text;
  } catch (err) {
    console.error('OCR failed:', err);
    return '';
  }
}

async function extractDocumentData(docType, pdfBuffer) {
  let text = '';
  try {
    const parsed = await pdfParse(pdfBuffer);
    text = parsed.text.replace(/\s+/g, ' ').trim();
    if (text.length < 20) throw new Error('Text too short — likely a scanned document.');
  } catch (err) {
    console.warn('Fallback to OCR:', err.message);

    // Save PDF buffer temporarily
    const tempPdfPath = path.join(__dirname, 'temp.pdf');
    const tempImgPath = path.join(__dirname, 'temp_page.jpg');
    fs.writeFileSync(tempPdfPath, pdfBuffer);

    // Convert first page of PDF to image
    const converter = fromPath(tempPdfPath, {
      density: 200,
      saveFilename: 'temp_page',
      savePath: __dirname,
      format: 'jpg',
      width: 1200,
      height: 1600
    });

    await converter(1); // Convert page 1

    text = await extractOCRText(tempImgPath);

    // Clean up
    fs.unlinkSync(tempPdfPath);
    fs.unlinkSync(tempImgPath);
  }

  const cleanedText = text.replace(/\s+/g, ' ').trim();

  switch (docType.toLowerCase()) {
  case 'national id':
    return {
      fullName: extractField(cleanedText, /(full\s*name|name|holder name)\s*[:\-]?\s*([a-zA-Z\s]+)/i),
      idNumber: extractField(cleanedText, /(id\s*number|identity\s*number|id)\s*[:\-]?\s*(\w{6,})/i),
      dob: extractField(cleanedText, /(dob|date\s*of\s*birth)\s*[:\-]?\s*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
    };

  case 'passport':
    return {
      fullName: extractField(cleanedText, /(full\s*name|name)\s*[:\-]?\s*([a-zA-Z\s]+)/i),
      passportNumber: extractField(cleanedText, /(passport\s*(no\.?|number))\s*[:\-]?\s*(\w{5,})/i),
      nationality: extractField(cleanedText, /(nationality|country)\s*[:\-]?\s*([a-zA-Z]+)/i)
    };

  case 'utility bill':
    return {
      accountName: extractField(cleanedText, /(account\s*(holder|name)|customer\s*name)\s*[:\-]?\s*([a-zA-Z\s]+)/i),
      address: extractField(cleanedText, /(address|service\s*location|billing\s*address)\s*[:\-]?\s*([\w\s\d,.-]+)/i)
    };

  case "driver's license":
  case 'drivers license':
    return {
      fullName: extractField(cleanedText, /(full\s*name|name)\s*[:\-]?\s*([a-zA-Z\s]+)/i),
      licenseNumber: extractField(cleanedText, /(license\s*(no\.?|number))\s*[:\-]?\s*(\w{5,})/i),
      expiryDate: extractField(cleanedText, /(expiry\s*date|valid\s*until)\s*[:\-]?\s*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
    };

  case 'birth certificate':
    return {
      fullName: extractField(cleanedText, /(full\s*name|name)\s*[:\-]?\s*([a-zA-Z\s]+)/i),
      dob: extractField(cleanedText, /(date\s*of\s*birth|dob)\s*[:\-]?\s*(\d{2}[\/\-]\d{2}[\/\-]\d{4})/i)
    };

  case 'business registration certificate':
    return {
      businessName: extractField(cleanedText, /(business\s*name|registered\s*name|company\s*name)\s*[:\-]?\s*([\w\s]+)/i),
      registrationNumber: extractField(cleanedText, /(registration\s*(no\.?|number)|reg\s*(no\.?))\s*[:\-]?\s*(\w{5,})/i)
    };

  case 'tax id (tin)':
  case 'tin':
    return {
      tinNumber: extractField(cleanedText, /(tin|tax\s*(id|number))\s*[:\-]?\s*(\d{6,})/i)
    };

  default:
    return null;
}
}

function extractField(text, regex) {
  const match = text.match(regex);
  return match ? match[2]?.trim() || match[1]?.trim() : null;
}

// Routes
//landing page
app.get('/', (req, res) => {
  res.render('landing');
});

// Register Route
app.post('/register', async (req, res) => {
  const { Login_ID, password, confirm_password, role } = req.body;

  if (password !== confirm_password) {
    return res.send('Passwords do not match. <a href="/">Try again</a>');
  }

  const table = role === 'organization' ? 'users' : 'users';

  const [results] = await db.execute(`SELECT * FROM ${table} WHERE Login_ID = ?`, [Login_ID]);
  if (results.length > 0) {
    return res.send(`${role} already exists. <a href="/">Try again</a>`);
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  await db.execute(
    `INSERT INTO ${table} (Login_ID, password, user_type) VALUES (?, ?, ?)`,
    [Login_ID, hashedPassword, role.charAt(0).toUpperCase() + role.slice(1)]
  );

  // Get inserted user ID
  const [[{ id: userId }]] = await db.execute(`SELECT id FROM Users WHERE Login_ID = ?`, [Login_ID]);

  // 🔍 Log the registration
  await logAudit({
    db,
    userId,
    action: 'User registered',
    targetType: 'user',
    targetId: userId,
    details: `New ${role} registered with Login_ID: ${Login_ID}`
  });

  res.send(`${role} registered successfully. <a href="/">Login</a>`);
});

app.post('/login', async (req, res) => {
  const { Login_ID, password, role } = req.body;

  let table = 'Users';
  let redirectPath;

  switch (role) {
    case 'customer': redirectPath = '/Customer-home'; break;
    case 'organization': redirectPath = '/organization-home'; break;
    case 'admin': redirectPath = '/admin-home'; break;
    case 'regulator': redirectPath = '/Regulator-home'; break;
    default: return res.send('Invalid role selected. <a href="/">Try again</a>');
  }

  const [results] = await db.execute(`SELECT * FROM ${table} WHERE Login_ID = ?`, [Login_ID]);
  if (results.length === 0) {
    return res.send(`No ${role} found with that ID. <a href="/">Try again</a>`);
  }

  const user = results[0];

  let passwordValid = false;

  if (user.user_type === 'Admin' || user.user_type === 'Regulator') {
    passwordValid = (password === user.password);
  } else {
    passwordValid = await bcrypt.compare(password, user.password);
  }

  if (!passwordValid) {
    return res.send('Invalid password. <a href="/">Try again</a>');
  }

  if (role === 'admin' && user.user_type !== 'Admin') {
    return res.send(`User type mismatch. This account is not an admin. <a href="/">Try again</a>`);
  }
  if (role === 'regulator' && user.user_type !== 'Regulator') {
    return res.send(`User type mismatch. This account is not a regulator. <a href="/">Try again</a>`);
  }

  req.session.user = user;
  req.session.role = role;

  // 🔍 Log successful login
  await logAudit({
    db,
    userId: user.id,
    action: 'User logged in',
    targetType: 'user',
    targetId: user.id,
    details: `${role} with Login_ID ${Login_ID} logged in`
  });

  res.redirect(redirectPath);
});

app.get('/Customer-home', async (req, res) => {
  if (!req.session.user || req.session.role !== 'customer') {
    return res.redirect('/');
  }
  
  const loginId = req.session.user.Login_ID;
  
  // Get full user info
  const [userResult] = await db.execute(`SELECT * FROM Users WHERE Login_ID = ?`, [loginId]);
  const user = userResult[0];
  
  // Audit log
  await logAudit({
    db,
    userId: user.id,
    action: 'Viewed customer dashboard',
    targetType: 'user',
    targetId: user.id,
    details: `Customer with Login_ID ${loginId} accessed their dashboard`
  });
  
  // Get customer profile
  const [customerResult] = await db.execute(`SELECT * FROM Customers WHERE user_id = ?`, [user.id]);
  const profile = customerResult[0] || {};
  const incompleteProfile = !profile.full_name || !profile.national_id;
  
  // ✅ FIX: Use profile.id (customer.id) instead of user.id
  const customerId = profile.id;
  
  if (!customerId) {
    // Handle case where customer profile doesn't exist
    return res.render('Customer-home', {
      user,
      profile,
      incompleteProfile: true,
      documents: [],
      approvedRequests: [],
      complianceSummary: {}
    });
  }
  
  // 🔽 Now fetch documents using the correct customer_id
  const [documents] = await db.execute(
    `SELECT * FROM Customer_Documents WHERE customer_id = ? ORDER BY uploaded_at DESC`,
    [customerId]  // ✅ Using customer.id instead of user.id
  );
  
  // Update other queries that also need customer_id instead of user_id
  const [approvedRequests] = await db.execute(`
    SELECT ar.*, org.name AS organization_name
    FROM Access_Requests ar
    JOIN Organizations org ON ar.organization_id = org.id
    WHERE ar.customer_id = ? AND ar.status = 'approved'
  `, [customerId]);  // ✅ Also fix this
  
  // Rest of your compliance logic...
  const complianceSummary = {};
  
  for (const request of approvedRequests) {
    const [requirements] = await db.execute(`
      SELECT odr.document_type_id, dt.name AS doc_type_name, odr.mandatory
      FROM Organization_Doc_Requirements odr
      JOIN Document_Types dt ON odr.document_type_id = dt.id
      WHERE odr.organization_id = ?
    `, [request.organization_id]);
    
    const [customerDocs] = await db.execute(`
      SELECT document_type_id
      FROM Customer_Documents
      WHERE customer_id = ?
    `, [customerId]);  // ✅ Fix this too
    
    const submittedTypes = new Set(customerDocs.map(d => d.document_type_id));
    
    complianceSummary[request.id] = requirements.map(req => ({
      ...req,
      submitted: submittedTypes.has(req.document_type_id)
    }));
  }
  
  res.render('Customer-home', {
    user,
    profile,
    incompleteProfile,
    documents,
    approvedRequests,
    complianceSummary
  });
});

app.get('/org-home', async (req, res) => {
  if (!req.session.user || req.session.role !== 'organization') {
    return res.redirect('/');
  }

  await logAudit({
    db,
    userId: req.session.user.id,
    action: 'Viewed organization dashboard',
    targetType: 'user',
    targetId: req.session.user.id,
    details: `Org Login_ID: ${req.session.user.Login_ID}`
  });

  res.render('org-home', {
    user: req.session.user,
    role: req.session.role
  });
});

app.get('/admin-home', async (req, res) => {
  if (!req.session.user || req.session.role !== 'admin') {
    return res.redirect('/');
  }

  await logAudit({
    db,
    userId: req.session.user.id,
    action: 'Viewed admin dashboard',
    targetType: 'user',
    targetId: req.session.user.id,
    details: `Admin Login_ID: ${req.session.user.Login_ID}`
  });

  res.render('admin-home', {
    user: req.session.user,
    role: req.session.role
  });
});

app.get('/Regulator-home', async (req, res) => {
  if (!req.session.user || req.session.role !== 'regulator') {
    return res.redirect('/');
  }
  

  await logAudit({
    db,
    userId: req.session.user.id,
    action: 'Viewed regulator dashboard',
    targetType: 'user',
    targetId: req.session.user.id,
    details: `Regulator Login_ID: ${req.session.user.Login_ID}`
  });

  res.render('Regulator-home', {
    user: req.session.user,
    role: req.session.role
  });
});

app.get('/logout', async (req, res) => {
  if (req.session.user) {
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'User logged out',
      targetType: 'user',
      targetId: req.session.user.id,
      details: `Logout by ${req.session.user.Login_ID}`
    });
  }

  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ====== Express Route Handlers for Role-Based Home Pages ======
// Middleware to check role access
function requireRole(role) {
  return function (req, res, next) {
    if (!req.session.user || req.session.role !== role) {
      return res.status(403).send('Access Denied');
    }
    next();
  };
}

// ===== Customer Dashboard =====
router.get('/customer-home', requireRole('customer'), async (req, res) => {
  await logAudit({
    db,
    userId: req.session.user.id,
    action: 'Viewed customer dashboard',
    details: `Customer ID: ${req.session.user.Login_ID}`
  });
  res.render('customer-home', { user: req.session.user });
});

// ===== Organization Dashboard =====
router.get('/organization-home', requireRole('organization'), async (req, res) => {
  await logAudit({
    db,
    userId: req.session.user.id,
    action: 'Viewed organization dashboard',
    details: `Organization ID: ${req.session.user.Login_ID}`
  });
  res.render('organization-home', { user: req.session.user });
});

// ===== Admin Dashboard =====
router.get('/admin-home', requireRole('admin'), async (req, res) => {
  await logAudit({
    db,
    userId: req.session.user.id,
    action: 'Viewed admin dashboard',
    details: `Admin ID: ${req.session.user.Login_ID}`
  });
  res.render('admin-home', { user: req.session.user });
});

// ===== Regulator Dashboard =====
router.get('/regulator-home', requireRole('regulator'), async (req, res) => {
  await logAudit({
    db,
    userId: req.session.user.id,
    action: 'Viewed regulator dashboard',
    details: `Regulator ID: ${req.session.user.Login_ID}`
  });
  res.render('regulator-home', { user: req.session.user });
});

// GET: Upload form with predefined document types
app.get('/Upload-Documents', async (req, res) => {
  if (!req.session.user || req.session.role !== 'customer') return res.redirect('/');

  const [documentTypes] = await db.query('SELECT id, name FROM Document_Types');
  res.render('upload', { documentTypes });
});

app.post('/upload', upload.array('documents'), async (req, res) => {
  // Authorization check
  if (!req.session.user || req.session.role !== 'customer') {
    return res.status(401).send('Unauthorized');
  }

  const customerId = req.session.user.id;
  const files = req.files || [];
  const { document_type_ids } = req.body;

  // Validation
  if (!files.length || !document_type_ids) {
    return res.status(400).send('No files or document types provided.');
  }

  const docTypeIdsArray = Array.isArray(document_type_ids) ? document_type_ids : [document_type_ids];
  
  if (files.length !== docTypeIdsArray.length) {
    return res.status(400).send('Mismatch between files and selected document types.');
  }

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const docTypeId = docTypeIdsArray[i];

      // Get document type information
      const [[docType]] = await db.execute(
        'SELECT name, validity_duration_days FROM Document_Types WHERE id = ?',
        [docTypeId]
      );

      if (!docType) {
        throw new Error(`Invalid document type selected: ${docTypeId}`);
      }

      const description = docType.name;
      const validityDays = docType.validity_duration_days || 365;
      const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000);

      // Extract document data if not a selfie with ID
      let extractedData = null;
      if (description.toLowerCase() !== 'selfie with id') {
        try {
          const pdfBuffer = fs.readFileSync(file.path);
          extractedData = await extractDocumentData(description, pdfBuffer);
        } catch (extractError) {
          console.warn(`Failed to extract data from ${description}:`, extractError);
          // Continue processing even if extraction fails
        }
      }

      const [[customer]] = await db.execute(
  `SELECT id FROM Customers WHERE user_id = ?`,
  [req.session.user.id]
);

if (!customer) {
  return res.status(400).send('No customer record found for current user.');
}

const customerId = customer.id;

      // Insert document record
      const [result] = await db.execute(
        `INSERT INTO Customer_Documents (customer_id, document_type_id, description, file_path, uploaded_at, expires_at, extracted_data)
         VALUES (?, ?, ?, ?, NOW(), ?, ?)`,
        [customerId, docTypeId, description, file.path, expiresAt, JSON.stringify(extractedData)]
      );

      // Log audit trail
      await logAudit({
        db,
        userId: customerId,
        action: 'Uploaded document',
        targetType: 'document',
        targetId: result.insertId,
        details: `Uploaded document of type "${description}"${extractedData ? ' with extracted data' : ''}`
      });
    }

    res.send('Documents uploaded and processed successfully. <a href="/Customer-home">Go Back</a>');
  } catch (err) {
    console.error('Upload processing error:', err);
    res.status(500).send('Failed to process document uploads.');
  }
});

app.post('/update-document', upload.single('newDoc'), async (req, res) => {
  const { docId } = req.body;
  const file = req.file;

  if (!file) return res.status(400).send('No file uploaded.');

  try {
    await db.execute(
      `UPDATE Customer_Documents SET file_path = ?, uploaded_at = NOW(), expires_at = ? WHERE id = ?`,
      [file.path, new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), docId]
    );

    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'Updated document',
      targetType: 'document',
      targetId: docId,
      details: `Re-uploaded file for document ID ${docId}`
    });

    res.redirect('/Customer-home');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error updating document.');
  }
});

app.post('/delete-document', async (req, res) => {
  const { docId } = req.body;

  try {
    await db.execute('DELETE FROM Customer_Documents WHERE id = ?', [docId]);

    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'Deleted document',
      targetType: 'document',
      targetId: docId,
      details: `User deleted document with ID ${docId}`
    });

    res.redirect('/Customer-home');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error deleting document.');
  }
});

app.get('/organization-home', async (req, res) => {
  if (!req.session.user || req.session.role !== 'organization') {
    return res.redirect('/');
  }

  const loginId = req.session.user.Login_ID;

  try {
    const [[user]] = await db.execute('SELECT * FROM Users WHERE Login_ID = ?', [loginId]);
    const [profileResult] = await db.execute('SELECT * FROM Organizations WHERE user_id = ?', [user.id]);
    const profile = profileResult[0] || {};
    const incompleteProfile = !profile.name || !profile.sector;

    // Log organization home page access
    await logAudit({
      db,
      userId: user.id,
      action: 'organization_home_access',
      targetType: 'page',
      targetId: null,
      details: `Organization ${profile.name || 'Unknown'} (ID: ${profile.id || 'N/A'}) accessed home page`
    });

    // ✅ STEP 1: Fetch approved access requests
    const [approvedCustomers] = profile.id ? await db.execute(
      `SELECT ar.id AS request_id, c.full_name AS customer_name, ar.approved_by, ar.requested_at AS approved_at,
             ar.valid_until, ar.purpose
      FROM Access_Requests ar
      JOIN Customers c ON ar.customer_id = c.id
      WHERE ar.organization_id = ? AND ar.status = 'approved'`, 
      [profile.id]
    ) : [[]];

    // Log viewing of approved customers (if any)
    if (approvedCustomers.length > 0) {
      await logAudit({
        db,
        userId: user.id,
        action: 'approved_customers_view',
        targetType: 'access_requests',
        targetId: null,
        details: `Organization ${profile.name} viewed ${approvedCustomers.length} approved customer access requests`
      });
    }

    // ✅ STEP 2: Build compliance summary with document access info
    const complianceSummary = {};
    let totalDocumentsAccessed = 0;

    // Only process if we have a valid profile
    if (profile.id) {
      for (const req of approvedCustomers) {
        // Required documents
        const [requiredDocs] = await db.execute(
          `SELECT dt.id AS doc_type_id, dt.name AS doc_type_name, od.mandatory
          FROM Organization_Doc_Requirements od
          JOIN Document_Types dt ON od.document_type_id = dt.id
          WHERE od.organization_id = ?`,
          [profile.id]
        );

        // Submitted docs with access levels
        const [submittedDocs] = await db.execute(
          `SELECT cd.document_type_id, cd.id AS document_id, ap.access_level
          FROM Customer_Documents cd
          JOIN Access_Permissions ap ON ap.document_id = cd.id
          WHERE cd.customer_id = ? AND ap.access_request_id = ?`,
          [req.approved_by, req.request_id]
        );

        // Count documents that this organization has access to
        totalDocumentsAccessed += submittedDocs.length;

        const submittedMap = new Map();
        submittedDocs.forEach(doc => {
          submittedMap.set(doc.document_type_id, {
            document_id: doc.document_id,
            access_level: doc.access_level
          });
        });

        complianceSummary[req.request_id] = requiredDocs.map(reqDoc => {
          const match = submittedMap.get(reqDoc.doc_type_id);
          return {
            doc_type_name: reqDoc.doc_type_name,
            mandatory: reqDoc.mandatory,
            submitted: !!match,
            document_id: match?.document_id || null,
            access_level: match?.access_level || null
          };
        });
      }

      // Log compliance summary generation
      if (Object.keys(complianceSummary).length > 0) {
        await logAudit({
          db,
          userId: user.id,
          action: 'compliance_summary_generated',
          targetType: 'compliance',
          targetId: profile.id,
          details: `Organization ${profile.name} generated compliance summary for ${Object.keys(complianceSummary).length} access requests with ${totalDocumentsAccessed} accessible documents`
        });
      }
    }

    // Log incomplete profile warning (if applicable)
    if (incompleteProfile) {
      await logAudit({
        db,
        userId: user.id,
        action: 'incomplete_profile_warning',
        targetType: 'organization_profile',
        targetId: profile.id || null,
        details: `Organization with incomplete profile accessed home page - Missing: ${!profile.name ? 'name' : ''} ${!profile.sector ? 'sector' : ''}`.trim()
      });
    }

    // ✅ STEP 3: Render
    res.render('organization-home', {
      user,
      profile,
      incompleteProfile,
      approvedCustomers,
      complianceSummary
    });

  } catch (err) {
    console.error('Error in organization-home:', err);
    
    // Log the error
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'organization_home_error',
      targetType: 'error',
      targetId: null,
      details: `Error accessing organization home page: ${err.message}`
    });

    res.status(500).send('Error loading organization home page');
  }
});

app.post('/organization-doc-settings', async (req, res) => {
  const {
    organization_id,
    document_type_id,
    mandatory = [],
    valid_for_days
  } = req.body;

  const docIds = Array.isArray(document_type_id) ? document_type_id : [document_type_id];
  const days = Array.isArray(valid_for_days) ? valid_for_days : [valid_for_days];

  try {
    for (let i = 0; i < docIds.length; i++) {
      const docId = parseInt(docIds[i]);
      const isMandatory = Array.isArray(mandatory)
        ? mandatory.includes(docId.toString()) || mandatory[i] === 'on'
        : false;
      const validDays = parseInt(days[i]);

      const [existing] = await db.query(
        `SELECT * FROM Organization_Doc_Requirements WHERE organization_id = ? AND document_type_id = ?`,
        [organization_id, docId]
      );

      if (existing.length > 0) {
        await db.query(
          `UPDATE Organization_Doc_Requirements SET mandatory = ?, valid_for_days = ? WHERE id = ?`,
          [isMandatory, validDays, existing[0].id]
        );

        await logAudit({
          db,
          userId: req.session.user.id,
          action: 'Updated document requirement',
          targetType: 'document_type',
          targetId: docId,
          details: `Updated doc ID ${docId}: mandatory=${isMandatory}, validDays=${validDays}`
        });
      } else {
        await db.query(
          `INSERT INTO Organization_Doc_Requirements (organization_id, document_type_id, mandatory, valid_for_days)
           VALUES (?, ?, ?, ?)`,
          [organization_id, docId, isMandatory, validDays]
        );

        await logAudit({
          db,
          userId: req.session.user.id,
          action: 'Added document requirement',
          targetType: 'document_type',
          targetId: docId,
          details: `Added doc ID ${docId}: mandatory=${isMandatory}, validDays=${validDays}`
        });
      }
    }

    res.redirect('/organization-doc-settings');
  } catch (err) {
    console.error('Error saving requirements:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/view-access-requests', async (req, res) => {
  if (!req.session.user || req.session.role !== 'customer') return res.redirect('/');

  const customerId = req.session.user.id;
  await logAudit({
  db,
  userId: customerId,
  action: 'Viewed access requests',
  details: `Customer viewed pending access requests`
});

  const [requests] = await db.query(`
    SELECT ar.*, o.name AS organization_name
    FROM Access_Requests ar
    JOIN Organizations o ON ar.organization_id = o.id
    WHERE ar.customer_id = ? AND ar.status = 'pending'
  `, [customerId]);

  const [documents] = await db.query(`
    SELECT id, description FROM Customer_Documents WHERE customer_id = ?
  `, [customerId]);

  // Attach customer_documents to each request object
  requests.forEach(req => {
    req.customer_documents = documents;
  });

  res.render('access-requests', {
    title: "Access Requests",
    requests
  });
});

app.post('/approve-access-request', async (req, res) => {
  const { requestId } = req.body;
  const customerId = req.session.user.id;

  try {
    await logAudit({
  db,
  userId: customerId,
  action: 'Approved access request',
  targetType: 'access_request',
  targetId: requestId,
  details: `Approved request ID ${requestId}, granted docs: ${JSON.stringify(docs)}`
});

    // Approve request
    await db.execute(`
      UPDATE Access_Requests
      SET status = 'approved', approved_by = ?
      WHERE id = ? AND customer_id = ?
    `, [customerId, requestId, customerId]);

    // Insert permissions
    const docs = req.body.docs || []; // array of selected doc IDs

    for (const docId of docs) {
      const accessLevel = req.body[`access_level_${docId}`] || 'read-only';

      await db.execute(`
        INSERT INTO Access_Permissions (access_request_id, document_id, granted_at, access_level)
        VALUES (?, ?, NOW(), ?)
      `, [requestId, docId, accessLevel]);
    }

    res.redirect('/view-access-requests');
  } catch (err) {
    console.error('Approval error:', err);
    res.status(500).send('Error approving request.');
  }
});

app.post('/reject-access-request', async (req, res) => {
  const { requestId } = req.body;
  const customerId = req.session.user.id;

  await db.execute(`
    UPDATE Access_Requests
    SET status = 'rejected'
    WHERE id = ? AND customer_id = ?
  `, [requestId, customerId]);
  await logAudit({
  db,
  userId: customerId,
  action: 'Rejected access request',
  targetType: 'access_request',
  targetId: requestId,
  details: `Rejected request ID ${requestId}`
});

  res.redirect('/view-access-requests');
});

app.post('/revoke-access', async (req, res) => {
  if (!req.session.user || req.session.role !== 'customer') return res.status(401).send("Unauthorized");

  const { request_id } = req.body;

  try {
    // Optional: Verify the access request belongs to the customer
    const [rows] = await db.execute(
      `SELECT * FROM Access_Requests WHERE id = ? AND customer_id = ? AND status = 'approved'`,
      [request_id, req.session.user.id]
    );

    if (rows.length === 0) {
      return res.status(400).send("Invalid access request.");
    }

    // Remove permissions
    await db.execute(`DELETE FROM Access_Permissions WHERE access_request_id = ?`, [request_id]);

    // Update request status to 'revoked'
    await db.execute(
      `UPDATE Access_Requests SET status = 'revoked' WHERE id = ?`,
      [request_id]
    );
    await logAudit({
  db,
  userId: req.session.user.id,
  action: 'Revoked access',
  targetType: 'access_request',
  targetId: request_id,
  details: `Revoked access for request ID ${request_id}`
});

    res.redirect('/Customer-home');
  } catch (err) {
    console.error("Revocation error:", err);
    res.status(500).send("Failed to revoke access.");
  }
});

app.get('/view/:documentId', async (req, res) => {
  if (!req.session.user || req.session.role !== 'organization') {
    return res.status(403).send("Unauthorized");
  }

  const loginId = req.session.user.Login_ID;
  const docId = req.params.documentId;

  try {
    // Get organization ID
    const [orgResult] = await db.query(`
      SELECT id FROM Organizations WHERE user_id = (SELECT id FROM Users WHERE Login_ID = ?)
    `, [loginId]);

    if (orgResult.length === 0) return res.status(400).send('Organization not found.');
    const organizationId = orgResult[0].id;

    // Check if organization has view permission
    const [rows] = await db.query(
      `SELECT cd.file_path FROM Access_Permissions ap
       JOIN Access_Requests ar ON ap.access_request_id = ar.id
       JOIN Customer_Documents cd ON ap.document_id = cd.id
       WHERE ar.organization_id = ? AND cd.id = ? AND ap.access_level IN ('view', 'download')`,
      [organizationId, docId]
    );

    if (rows.length === 0) return res.status(403).send("You don't have view permission for this document.");

    // Log successful document view
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'document_view',
      targetType: 'document',
      targetId: docId,
      details: `Organization ${organizationId} viewed document ${docId}`
    });

    const filePath = path.resolve(__dirname, rows[0].file_path);
    res.sendFile(filePath);
  } catch (err) {
    console.error('Error in view document:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/metadata/:documentId', async (req, res) => {
  if (!req.session.user || req.session.role !== 'organization') {
    return res.status(403).send("Unauthorized");
  }

  const loginId = req.session.user.Login_ID;
  const docId = req.params.documentId;

  try {
    // Get organization ID
    const [orgResult] = await db.query(`
      SELECT id FROM Organizations WHERE user_id = (SELECT id FROM Users WHERE Login_ID = ?)
    `, [loginId]);

    if (orgResult.length === 0) return res.status(400).send('Organization not found.');
    const organizationId = orgResult[0].id;

    // Check permission for view-metadata
    const [rows] = await db.query(`
      SELECT cd.id, cd.name, cd.description, cd.created_at
      FROM Access_Permissions ap
      JOIN Access_Requests ar ON ap.access_request_id = ar.id
      JOIN Customer_Documents cd ON ap.document_id = cd.id
      WHERE ar.organization_id = ? AND cd.id = ? AND ap.access_level = 'view-metadata'
    `, [organizationId, docId]);

    if (rows.length === 0) return res.status(403).send("You don't have metadata access.");

    // Log metadata access
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'metadata_view',
      targetType: 'document',
      targetId: docId,
      details: `Organization ${organizationId} accessed metadata for document ${docId}`
    });

    res.json(rows[0]);
  } catch (err) {
    console.error('Error in metadata access:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/download/:id', async (req, res) => {
  if (!req.session.user || req.session.role !== 'organization') {
    return res.status(403).send('Unauthorized');
  }

  const documentId = req.params.id;

  try {
    // 1. Fetch document metadata (only file_path exists in your table)
    const [[document]] = await db.execute(`
      SELECT file_path
      FROM Customer_Documents
      WHERE id = ?
    `, [documentId]);

    if (!document) {
      return res.status(404).send('Document not found');
    }

    // Log download attempt
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'document_download',
      targetType: 'document',
      targetId: documentId,
      details: `User ${req.session.user.Login_ID} downloaded document ${documentId}`
    });

    // 2. Construct absolute path and send file
    const path = require('path');
    const filePath = path.join(__dirname, document.file_path);

    // Extract filename from the file_path for download
    const fileName = path.basename(document.file_path);

    res.download(filePath, fileName, (err) => {
      if (err) {
        console.error('Download error:', err);
        res.status(500).send('Failed to download file');
      }
    });
  } catch (err) {
    console.error('Error in download:', err);
    res.status(500).send('Internal server error');
  }
});

app.get('/admin/view-users', async (req, res) => {
  if (!req.session.user || req.session.role !== 'admin') {
    return res.redirect('/');
  }

  try {
    const [users] = await db.execute(`SELECT * FROM Users ORDER BY created_at DESC`);
    
    // Log admin accessing user list
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'admin_view_users',
      targetType: 'system',
      targetId: null,
      details: `Admin ${req.session.user.Login_ID} accessed user list`
    });

    res.render('all-users', { users });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).send('Error loading users');
  }
});

app.get('/admin/system-logs', async (req, res) => {
  if (!req.session.user || req.session.role !== 'admin') {
    return res.redirect('/');
  }

  try {
    const [logs] = await db.execute(`
      SELECT al.*, u.Login_ID, u.user_type
      FROM Audit_Log al
      JOIN Users u ON al.user_id = u.id
      ORDER BY al.timestamp DESC
      LIMIT 100
    `);

    // Log admin accessing system logs
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'admin_view_logs',
      targetType: 'system',
      targetId: null,
      details: `Admin ${req.session.user.Login_ID} accessed system audit logs`
    });

    res.render('admin-logs', { logs });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading logs.");
  }
});

app.post('/update-customer-profile', async (req, res) => {
  // Check if user is logged in and is a customer
  if (!req.session.user || req.session.role !== 'customer') {
    return res.status(403).send('Unauthorized');
  }

  const { full_name, national_id } = req.body;
  const userId = req.session.user.id; // or however you store the user ID in session

  // Validate required fields
  if (!full_name || !national_id) {
    return res.status(400).send('Full name and National ID are required');
  }

  try {
    // Check if customer profile already exists
    const [existingCustomer] = await db.execute(`
      SELECT id FROM Customers WHERE user_id = ?
    `, [userId]);

    if (existingCustomer.length > 0) {
      // Update existing customer profile
      await db.execute(`
        UPDATE Customers 
        SET full_name = ?, national_id = ?
        WHERE user_id = ?
      `, [full_name, national_id, userId]);

      // Log the profile update
      await logAudit({
        db,
        userId: userId,
        action: 'customer_profile_update',
        targetType: 'customer_profile',
        targetId: existingCustomer[0].id,
        details: `Customer profile updated - Name: ${full_name}, National ID: ${national_id}`
      });

    } else {
      // Create new customer profile
      const [result] = await db.execute(`
        INSERT INTO Customers (user_id, full_name, national_id)
        VALUES (?, ?, ?)
      `, [userId, full_name, national_id]);

      // Log the profile creation
      await logAudit({
        db,
        userId: userId,
        action: 'customer_profile_create',
        targetType: 'customer_profile',
        targetId: result.insertId,
        details: `Customer profile created - Name: ${full_name}, National ID: ${national_id}`
      });
    }

    // Redirect to dashboard or wherever appropriate after successful update
    res.redirect('/customer-home'); // or wherever you want to redirect
    
  } catch (err) {
    console.error('Error updating customer profile:', err);
    
    // Check if it's a duplicate national_id error
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).send('This National ID is already registered by another user');
    }
    
    res.status(500).send('Error updating profile');
  }
});

app.post('/update-organization-profile', async (req, res) => {
  // Check if user is logged in and is an organization
  if (!req.session.user || req.session.role !== 'organization') {
    return res.status(403).send('Unauthorized');
  }

  const { name, sector } = req.body;
  const userId = req.session.user.id; // or however you store the user ID in session

  // Validate required fields
  if (!name || !sector) {
    return res.status(400).send('Business name and sector are required');
  }

  try {
    // Check if organization profile already exists
    const [existingOrg] = await db.execute(`
      SELECT id FROM Organizations WHERE user_id = ?
    `, [userId]);

    if (existingOrg.length > 0) {
      // Update existing organization profile
      await db.execute(`
        UPDATE Organizations 
        SET name = ?, sector = ?
        WHERE user_id = ?
      `, [name, sector, userId]);

      // Log the profile update
      await logAudit({
        db,
        userId: userId,
        action: 'organization_profile_update',
        targetType: 'organization_profile',
        targetId: existingOrg[0].id,
        details: `Organization profile updated - Name: ${name}, Sector: ${sector}`
      });

    } else {
      // Create new organization profile
      const [result] = await db.execute(`
        INSERT INTO Organizations (user_id, name, sector)
        VALUES (?, ?, ?)
      `, [userId, name, sector]);

      // Log the profile creation
      await logAudit({
        db,
        userId: userId,
        action: 'organization_profile_create',
        targetType: 'organization_profile',
        targetId: result.insertId,
        details: `Organization profile created - Name: ${name}, Sector: ${sector}`
      });
    }

    // Redirect to organization dashboard or wherever appropriate after successful update
    res.redirect('/organization-home'); // or wherever you want to redirect
    
  } catch (err) {
    console.error('Error updating organization profile:', err);
    
    // Check if it's a duplicate name error (if you have unique constraint on name)
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).send('This organization name is already registered');
    }
    
    res.status(500).send('Error updating organization profile');
  }
});

app.get('/export-extracted-data', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT cd.id, cd.customer_id, dt.name AS document_type, cd.extracted_data, cd.uploaded_at
      FROM Customer_Documents cd
      JOIN Document_Types dt ON cd.document_type_id = dt.id
      ORDER BY cd.uploaded_at DESC
    `);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Extracted Data');

    sheet.columns = [
      { header: 'Document ID', key: 'id', width: 12 },
      { header: 'Customer ID', key: 'customer_id', width: 15 },
      { header: 'Document Type', key: 'document_type', width: 25 },
      { header: 'Full Name', key: 'fullName', width: 25 },
      { header: 'ID Number', key: 'idNumber', width: 20 },
      { header: 'DOB', key: 'dob', width: 15 },
      { header: 'Uploaded At', key: 'uploaded_at', width: 20 }
    ];

    for (const row of rows) {
      let extracted = {};

      if (typeof row.extracted_data === 'string') {
        try {
          extracted = JSON.parse(row.extracted_data);
        } catch (err) {
          console.warn(`Skipping bad JSON in row ${row.id}:`, err.message);
        }
      } else if (typeof row.extracted_data === 'object' && row.extracted_data !== null) {
        extracted = row.extracted_data;
      }

      sheet.addRow({
        id: row.id,
        customer_id: row.customer_id,
        document_type: row.document_type,
        fullName: extracted.fullName || '',
        idNumber: extracted.idNumber || extracted.passportNumber || extracted.licenseNumber || extracted.tinNumber || '',
        dob: extracted.dob || extracted.expiryDate || '',
        uploaded_at: row.uploaded_at
      });
    }

    res.setHeader('Content-Disposition', 'attachment; filename="extracted_data.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).send('Failed to export data.');
  }
});

app.get('/system-logs', async (req, res) => {
  if (!req.session.user || req.session.role !== 'regulator') {
    return res.redirect('/');
  }

  try {
    const [logs] = await db.execute(`
      SELECT al.*, u.Login_ID, u.user_type
      FROM Audit_Log al
      JOIN Users u ON al.user_id = u.id
      ORDER BY al.timestamp DESC
      LIMIT 100
    `);

    // Log admin accessing system logs
    await logAudit({
      db,
      userId: req.session.user.id,
      action: 'regulator_view_logs',
      targetType: 'system',
      targetId: null,
      details: `regulator ${req.session.user.Login_ID} accessed system audit logs`
    });

    res.render('regulator-logs', { logs });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading logs.");
  }
});

app.get('/compliance-requirements', async (req, res) => {
  try {
    const [requirements] = await db.execute(`
      SELECT 
        o.name AS organization_name,
        dt.name AS document_type,
        r.mandatory,
        r.valid_for_days
      FROM Organization_Doc_Requirements r
      JOIN Organizations o ON r.organization_id = o.id
      JOIN Document_Types dt ON r.document_type_id = dt.id
      ORDER BY o.name, dt.name
    `);

    res.render('Compliance', { requirements });
  } catch (err) {
    console.error('Failed to load compliance requirements:', err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/admin/analytics', requireRole('admin'), async (req, res) => {
  try {
    const [users] = await db.execute('SELECT COUNT(*) AS total FROM Customers');
    const [docs] = await db.execute('SELECT COUNT(*) AS total FROM Customer_Documents');
    const [docsPerType] = await db.execute(`
      SELECT dt.name AS type, COUNT(cd.id) AS count
      FROM Customer_Documents cd
      JOIN Document_Types dt ON cd.document_type_id = dt.id
      GROUP BY cd.document_type_id
    `);
    const [expired] = await db.execute(`
      SELECT COUNT(*) AS total FROM Customer_Documents WHERE expires_at IS NOT NULL AND expires_at < NOW()
    `);

    const [compliance] = await db.execute(`
      SELECT o.name AS organization, dt.name AS document_type
      FROM Organization_Doc_Requirements odr
      JOIN Organizations o ON odr.organization_id = o.id
      JOIN Document_Types dt ON odr.document_type_id = dt.id
      WHERE odr.mandatory = 1
    `);

    res.render('admin-analytics', {
      user: req.session.user,
      users: users[0].total,
      docs: docs[0].total,
      docsPerType,
      expired: expired[0].total,
      compliance
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).send('Failed to load analytics.');
  }
});










// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));