const form = document.getElementById("access");
const status = document.getElementById("status");
const create = document.getElementById("create");
const pairing = document.getElementById("pairing");
const copy = document.getElementById("copy");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  create.disabled = true;
  status.textContent = "Creating your connection link…";
  document.getElementById("connection").hidden = true;
  document.getElementById("examples").hidden = true;
  try {
    const fields = new FormData(form);
    const response = await fetch("/review/pairing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: fields.get("username"), password: fields.get("password") }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    pairing.value = result.pairingUrl;
    document.getElementById("qr").src = result.qrImage;
    document.getElementById("expiry").textContent =
      `Use this link before ${new Date(result.expiresAt).toLocaleTimeString()}.`;
    document.getElementById("connection").hidden = false;
    document.getElementById("examples").hidden = false;
    create.textContent = "Create another connection link";
    copy.textContent = "Copy connection link";
    status.textContent = "Your connection link is ready.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Please try again.";
  } finally {
    create.disabled = false;
  }
});

copy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(pairing.value);
    copy.textContent = "Copied";
  } catch {
    pairing.focus();
    pairing.select();
    copy.textContent = "Select and copy the link above";
  }
});
