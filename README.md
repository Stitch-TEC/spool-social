# 🧵 Spool
> **Content approval workflows, simplified.**

[![Live Demo](https://img.shields.io/badge/🚀_Launch-Live_Demo-indigo?style=for-the-badge)](https://YOUR_USERNAME.github.io/spool-app/)
![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Firebase](https://img.shields.io/badge/firebase-ffca28?style=for-the-badge&logo=firebase&logoColor=black)

**Spool** is a lightweight, agency-focused tool designed to streamline the process of drafting social media content and getting client approval. It replaces messy spreadsheets with a clean, visual dashboard and generates secure, read-only links for clients to review work.

---

## ✨ Key Features

* **🎨 Multi-Channel Drafting:** Create and preview posts for LinkedIn, X (Twitter), Instagram, and Google Business Profile.
* **🔗 Client Approval Links:** Generate unique, shareable URLs for clients to review content without needing an account.
* **🤖 AI Magic Rewriting:** (V2) Integrated Gemini AI to rephrase content instantly (Professional, Punchy, or Emojified).
* **🖼️ Smart Media Handling:** Automatic client-side image compression to optimize storage within Firestore constraints.
* **📅 Calendar & Grid Views:** Visualize content schedules at a glance.
* **🔒 Secure Architecture:** Environment variable protection for API keys and sensitive data.

---

## 🛠️ Tech Stack

* **Frontend:** React (Vite), Tailwind CSS
* **Backend:** Firebase (Firestore, Auth)
* **Icons:** Lucide React
* **Deployment:** GitHub Pages

---

## 🚀 Getting Started

### Prerequisites
* Node.js (v18+)
* A Firebase Project

### Installation

1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/YOUR_USERNAME/spool-app.git](https://github.com/YOUR_USERNAME/spool-app.git)
    cd spool-app
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Environment Variables:**
    Create a `.env` file in the root directory. Do **not** commit this file.
    ```env
    VITE_FIREBASE_API_KEY=your_api_key
    VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
    VITE_FIREBASE_PROJECT_ID=your_project_id
    VITE_FIREBASE_STORAGE_BUCKET=your_project.firebasestorage.app
    VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
    VITE_FIREBASE_APP_ID=your_app_id
    VITE_GEMINI_API_KEY=your_gemini_key_optional
    ```

4.  **Run Locally:**
    ```bash
    npm run dev
    ```

---

## 📦 Deployment

This project is configured for automated deployment to **GitHub Pages**.

### Manual Deploy
To build and deploy the project from your local machine:

```bash
npm run deploy