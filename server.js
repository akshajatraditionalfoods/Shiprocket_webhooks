require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const JSON_FILE = path.join(__dirname, 'pending-orders.json');

let shiprocketToken = "";
let tokenFetchedAt = 0;

/* ---------------- SHIPROCKET AUTH ---------------- */

async function fetchShiprocketToken() {
  console.log("🔐 Fetching Shiprocket token...");
  const res = await fetch(
    "https://apiv2.shiprocket.in/v1/external/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: SHIPROCKET_EMAIL,
        password: SHIPROCKET_PASSWORD
      })
    }
  );

  const text = await res.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Shiprocket login returned non-JSON");
  }

  if (!data.token) {
    throw new Error("Shiprocket login failed: " + text);
  }

  shiprocketToken = `Bearer ${data.token}`;
  tokenFetchedAt = Date.now();

  console.log("✅ Shiprocket token ready");
}

async function ensureShiprocketToken() {
  const TEN_HOURS = 10 * 60 * 60 * 1000;
  if (!shiprocketToken || Date.now() - tokenFetchedAt > TEN_HOURS) {
    await fetchShiprocketToken();
  }
}

/* ---------------- MIDDLEWARE ---------------- */

app.use('/webhooks/orders_create', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

/* ---------------- HELPERS ---------------- */

function verifyShopifyHmac(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');

  return crypto.timingSafeEqual(
    Buffer.from(digest),
    Buffer.from(hmacHeader)
  );
}

function storePendingOrder(shipment_id, order_id) {
  let orders = [];
  if (fs.existsSync(JSON_FILE)) {
    orders = JSON.parse(fs.readFileSync(JSON_FILE));
  }
  orders.push({ shipment_id, order_id, created_at: new Date() });
  fs.writeFileSync(JSON_FILE, JSON.stringify(orders, null, 2));
}

function getUpcomingMondayDateTime() {
  const now = new Date();
  const monday = new Date();
  const days = (1 - now.getDay() + 7) % 7 || 7;
  monday.setDate(now.getDate() + days);
  monday.setHours(4, 0, 0, 0);
  return monday.toISOString().slice(0, 19).replace('T', ' ');
}

/* ---------------- ROUTES ---------------- */

app.get('/order', (_, res) => res.send("📦 Order API is live"));

app.post('/webhooks/orders_create', async (req, res) => {
  try {
    if (!verifyShopifyHmac(req)) {
      console.error("❌ Invalid Shopify HMAC");
      return res.status(200).send("OK");
    }

    console.log("✅ New Shopify Order Received");
    const order = JSON.parse(req.body.toString());

    const zip = order.billing_address?.zip || "";
    let latitude = "0.0";
    let longitude = "0.0";

    try {
      const geo = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${GOOGLE_MAPS_API_KEY}`
      );
      const geoData = await geo.json();
      if (geoData.results?.length) {
        latitude = geoData.results[0].geometry.location.lat.toString();
        longitude = geoData.results[0].geometry.location.lng.toString();
        console.log(`📍 ZIP ${zip} → ${latitude}, ${longitude}`);
      }
    } catch {}

    const payload = {
      order_id: order.id.toString(),
      order_date: order.created_at,
      pickup_location: "Home-1",
      billing_customer_name: order.billing_address?.first_name || "Customer",
      billing_last_name: order.billing_address?.last_name || "",
      billing_address: order.billing_address?.address1 || "",
      billing_city: order.billing_address?.city || "",
      billing_pincode: zip,
      billing_state: order.billing_address?.province || "",
      billing_country: order.billing_address?.country || "",
      billing_email: order.email,
      billing_phone: order.customer?.phone || "9999999999",
      shipping_is_billing: true,
      order_items: order.line_items.map(i => ({
        name: i.name,
        sku: i.sku || "SKU",
        units: i.quantity,
        selling_price: i.price,
        hsn: 441122
      })),
      payment_method: order.financial_status === "paid" ? "Prepaid" : "COD",
      sub_total: order.subtotal_price,
      length: 10,
      breadth: 10,
      height: 10,
      weight: 1,
      latitude,
      longitude
    };

    await ensureShiprocketToken();

    const srRes = await fetch(
      "https://apiv2.shiprocket.in/v1/external/orders/create/adhoc",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": shiprocketToken
        },
        body: JSON.stringify(payload)
      }
    );

    const raw = await srRes.text();
    console.log("🚚 Shiprocket raw:", raw);

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Shiprocket returned HTML / non-JSON");
    }

    if (!data.shipment_id) {
      throw new Error("Shipment ID missing");
    }

    storePendingOrder(data.shipment_id, order.id);
    console.log("📦 Stored for AWB assignment");
    res.status(200).send("OK");

  } catch (err) {
    console.error("❌ Error:", err.message);
    res.status(200).send("OK");
  }
});

/* ---------------- CRON ---------------- */

cron.schedule('0 0 2 * * 0', async () => {
  console.log("⏰ Sunday Cron Started");

  if (!fs.existsSync(JSON_FILE)) return;
  const orders = JSON.parse(fs.readFileSync(JSON_FILE));
  const remaining = [];

  for (const o of orders) {
    try {
      await ensureShiprocketToken();

      const res = await fetch(
        "https://apiv2.shiprocket.in/v1/external/courier/assign/awb",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": shiprocketToken
          },
          body: JSON.stringify({
            shipment_id: o.shipment_id,
            future_pickup_scheduled: getUpcomingMondayDateTime()
          })
        }
      );

      const raw = await res.text();
      const data = JSON.parse(raw);

      if (data.awb_code) {
        console.log("✅ AWB Assigned:", data.awb_code);
      } else {
        remaining.push(o);
      }
    } catch {
      remaining.push(o);
    }
  }

  fs.writeFileSync(JSON_FILE, JSON.stringify(remaining, null, 2));
});

/* ---------------- SERVER ---------------- */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on ${PORT}`);
});
