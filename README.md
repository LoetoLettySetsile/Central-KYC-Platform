# 🛡️ Centralized KYC Platform

A Node.js + MySQL-based web application for managing KYC (Know Your Customer) processes, document submissions, role-based access, and compliance requirements for regulated institutions.

## 📌 Features

- 🔐 User Authentication with Role-Based Access (`admin`, `customer`, `organization`, `regulator`)
- 📄 Document Upload and Validation
- 📤 OCR and PDF Data Extraction (Tesseract + pdf-parse)
- 🧾 Auto-Fill KYC Details from Scanned Docs
- ✅ Document Type Compliance by Organization
- 📈 Admin Analytics Dashboard
- 📥 Excel Export of Extracted Data
- 🧮 Audit Logs for Transparency and Tracking
- 🧰 Full CRUD on Users, Docs, and Organizations

## 🛠️ Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** EJS + Bootstrap
- **Database:** MySQL
- **OCR:** Tesseract.js
- **PDF Parsing:** pdf-parse
- **Excel Export:** exceljs

## 🚀 Setup Instructions

### 1. Clone the Repository

```bash
git clone https://github.com/your-username/centralized-kyc-platform.git
cd centralized-kyc-platform
