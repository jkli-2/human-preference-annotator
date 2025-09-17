const API_BASE = "http://localhost:3000/api";
// const API_BASE = "https://human-preference-api.onrender.com/api";
let adminToken = "";

const loginBtn = document.getElementById("loginBtn");
const loginMsg = document.getElementById("loginMsg");
const dashboard = document.getElementById("dash") || document.getElementById("dashboard");

const progressMsg = document.getElementById("progressMsg");
const tokensMsg = document.getElementById("tokensMsg");
const progressTbody =
    document.querySelector("#progressTable tbody") || document.getElementById("progressTable");
const tokensTbody = document.querySelector("#tokensTable tbody");

document.getElementById("refreshProgressBtn")?.addEventListener("click", fetchProgress);
document.getElementById("refreshTokensBtn")?.addEventListener("click", fetchTokens);
document.getElementById("addAnnotatorBtn")?.addEventListener("click", addAnnotator);
document.getElementById("removeAnnotatorBtn")?.addEventListener("click", removeAnnotator);
document.getElementById("flushBtn")?.addEventListener("click", flushDatabase);
document.getElementById("downloadBtn")?.addEventListener("click", downloadAnnotations);

loginBtn?.addEventListener("click", login);
document.getElementById("adminPassword")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    login(); // call the same function
  }
});

async function login() {
    const password = document.getElementById("adminPassword").value.trim();
    loginMsg.textContent = "Checking...";
    try {
        const res = await fetch(`${API_BASE}/admin/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ password }),
        });
        if (!res.ok) throw new Error("Invalid password");
        const data = await res.json();
        adminToken = data.token;
        document.getElementById("loginSection").style.display = "none";
        dashboard.style.display = "block";
        loginMsg.textContent = "";
        await refreshAll();
    } catch (e) {
        loginMsg.textContent = e.message;
    }
}

async function refreshAll() {
    await Promise.all([fetchProgress(), fetchTokens()]);
}

async function fetchProgress() {
    if (progressMsg) progressMsg.textContent = "Loading...";
    const res = await fetch(`${API_BASE}/admin/progress?token=${encodeURIComponent(adminToken)}`);
    if (!res.ok) {
        if (progressMsg) progressMsg.textContent = "Error";
        return;
    }
    const rows = await res.json();
    if (progressTbody && progressTbody.tagName === "TBODY") {
        progressTbody.innerHTML = "";
        rows.forEach((r) => {
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${r.annotatorId}</td><td>${r.completed}</td><td>${r.total}</td>`;
            progressTbody.appendChild(tr);
        });
    } else if (progressTbody) {
        // Fallback if using a simple table element in your original UI
        progressTbody.innerHTML =
            "<tr><th>Annotator ID</th><th>Completed</th><th>Total</th></tr>" +
            rows
                .map(
                    (r) =>
                        `<tr><td>${r.annotatorId}</td><td>${r.completed}</td><td>${r.total}</td></tr>`
                )
                .join("");
    }
    if (progressMsg) progressMsg.textContent = `Loaded ${rows.length}`;
}

async function fetchTokens() {
    if (tokensMsg) tokensMsg.textContent = "Loading...";
    const res = await fetch(`${API_BASE}/admin/tokens?token=${encodeURIComponent(adminToken)}`);
    if (!res.ok) {
        if (tokensMsg) tokensMsg.textContent = "Error";
        return;
    }
    const rows = await res.json();
    tokensTbody.innerHTML = "";
    rows.forEach((r) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
      <td>${r.annotatorId}</td>
      <td><code>${r.token}</code></td>
      <td>
        <button data-token="${r.token}" class="removeByToken">Remove</button>
        <button data-token="${r.token}" class="copyURL">Copy URL</button>
        <button data-token="${r.token}" class="openURL">Open</button>
      </td>`;
        tokensTbody.appendChild(tr);
    });

    tokensTbody
        .querySelectorAll(".removeByToken")
        .forEach((btn) =>
            btn.addEventListener("click", () => removeAnnotator({ token: btn.dataset.token }))
        );
    tokensTbody
        .querySelectorAll(".copyURL")
        .forEach((btn) =>
            btn.addEventListener("click", () => {
                const token = btn.dataset.token;
                let basePath = window.location.pathname.replace(/\/admin\/?$/, "/");
                const url = `${window.location.origin}${basePath}?token=${encodeURIComponent(token)}`;
                navigator.clipboard.writeText(url).then(() => {
                    console.log(`Copied: ${url}`);
                }).catch(err => {
                    console.error("Failed to copy URL:", err);
                });
            })
        );
    tokensTbody
    .querySelectorAll(".openURL")
    .forEach((btn) =>
        btn.addEventListener("click", () => {
            const token = btn.dataset.token;
            let basePath = window.location.pathname.replace(/\/admin\/?$/, "/");
            const url = `${window.location.origin}${basePath}?token=${encodeURIComponent(token)}`;
            window.open(url, "_blank");
        })
    );
    // tokensTbody
    //     .querySelectorAll(".removeById")
    //     .forEach((btn) =>
    //         btn.addEventListener("click", () => removeAnnotator({ annotatorId: btn.dataset.id }))
    //     );

    if (tokensMsg) tokensMsg.textContent = `Loaded ${rows.length}`;
}

async function downloadAnnotations() {
    const res = await fetch(`${API_BASE}/admin/export?token=${encodeURIComponent(adminToken)}`);
    if (!res.ok) return alert("Error exporting");
    const data = await res.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "annotations.json";
    a.click();
    URL.revokeObjectURL(url);
}

async function flushDatabase() {
    if (!confirm("This will DELETE ALL annotation and progress data. Continue?")) return;
    const res = await fetch(`${API_BASE}/admin/flush?token=${encodeURIComponent(adminToken)}`, {
        method: "POST",
    });
    alert(res.ok ? "Database flushed." : "Error.");
}

async function addAnnotator() {
    const annotatorId = document.getElementById("newAnnotatorId").value.trim();
    const msg = document.getElementById("addAnnotatorMsg");
    const out = document.getElementById("generatedToken");
    if (msg) msg.textContent = "";
    if (out) out.textContent = "";

    if (!annotatorId) {
        if (msg) msg.textContent = "Annotator ID required";
        return;
    }

    const res = await fetch(
        `${API_BASE}/admin/add-annotator?token=${encodeURIComponent(adminToken)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ annotatorId }),
        }
    );
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (msg) msg.textContent = err.error || "Error adding annotator";
        return;
    }
    const data = await res.json();
    if (out) out.textContent = `Generated token for ${data.annotatorId}: ${data.token}`;
    document.getElementById("newAnnotatorId").value = "";
    await fetchTokens();
}

async function removeAnnotator(payload) {
    const res = await fetch(
        `${API_BASE}/admin/remove-annotator?token=${encodeURIComponent(adminToken)}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        }
    );
    if (res.ok) {
        alert("Removed.");
        document.getElementById("removeAnnotatorId").value = "";
        document.getElementById("removeToken").value = "";
        await fetchTokens();
    } else {
        alert("Error removing");
    }
}
