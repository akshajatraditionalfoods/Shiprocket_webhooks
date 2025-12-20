require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

/* ================== ENV ================== */
const {
  SHIPROCKET_EMAIL,
  SHIPROCKET_PASSWORD,
  GOOGLE_MAPS_API_KEY,
  SHOPIFY_WEBHOOK_SECRET
} = process.env;

/* ================== STORAGE ================== */
const JSON_FILE = path.join(__dirname, 'pending-orders.json');
let shiprocketToken = "";

/* ================== MIDDLEWARE ================== */
// Raw body ONLY for Shopify webhook
app.use('/webhooks/orders_create', bodyParser.raw({ type: 'application/json' }));
// JSON for everything else
app.use(bodyParser.json());

/* ================== HELPERS ================== */

// 🔐 Shopify HMAC Verification
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

// 🔐 Shiprocket Token Fetch
async function fetchShiprocketToken() {
  const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: SHIPROCKET_EMAIL,
      password: SHIPROCKET_PASSWORD
    })
  });

  const data = await res.json();
  if (!data.token) throw new Error("Shiprocket auth failed");

  shiprocketToken = `Bearer ${data.token}`;
  console.log("✅ Shiprocket token refreshed");
}

async function getShiprocketAuth() {
  if (!shiprocketToken) {
    await fetchShiprocketToken();
  }
  return shiprocketToken;
}

// 📦 Local persistence (TEMP – replace with DB in prod)
function storePendingOrder(shipment_id, order_id) {
  const orders = fs.existsSync(JSON_FILE)
    ? JSON.parse(fs.readFileSync(JSON_FILE))
    : [];

  orders.push({
    shipment_id,
    order_id,
    created_at: new Date().toISOString()
  });

  fs.writeFileSync(JSON_FILE, JSON.stringify(orders, null, 2));
}

// 📅 Next Monday 4AM
function getUpcomingMondayDateTime() {
  const now = new Date();
  const monday = new Date();
  const days = (1 - now.getDay() + 7) % 7 || 7;
  monday.setDate(now.getDate() + days);
  monday.setHours(4, 0, 0, 0);
  return monday.toISOString().slice(0, 19).replace('T', ' ');
}

/* ================== ROUTES ================== */

app.get('/order', (_, res) => {
  res.send("📦 Order API is live");
});

/* ================== SHOPIFY WEBHOOK ================== */

app.post('/webhooks/orders_create', async (req, res) => {
  // 🔒 Verify HMAC
  if (!verifyShopifyHmac(req)) {
    console.error("❌ Invalid Shopify HMAC");
    return res.status(401).send("Unauthorized");
  }

  // Respond immediately (Shopify requirement)
  res.status(200).send("Webhook received");

  const order = JSON.parse(req.body.toString());
  console.log(`✅ Order received: ${order.id}`);

  try {
    const deliveryInfo = {};
    (order.note_attributes || []).forEach(a => deliveryInfo[a.name] = a.value);

    const zip = order.billing_address?.zip || "";
    let latitude = "0.0";
    let longitude = "0.0";

    if (zip) {
      const geoRes = await fetch(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${GOOGLE_MAPS_API_KEY}`
      );
      const geo = await geoRes.json();
      if (geo.status === "OK") {
        latitude = geo.results[0].geometry.location.lat.toString();
        longitude = geo.results[0].geometry.location.lng.toString();
      }
    }

    const payload = {
      order_id: String(order.id),
      order_date: order.created_at,
      pickup_location: "Home-1",
      billing_customer_name: order.billing_address?.first_name || "Customer",
      billing_last_name: order.billing_address?.last_name || "",
      billing_address: order.billing_address?.address1 || "",
      billing_city: order.billing_address?.city || "",
      billing_pincode: order.billing_address?.zip || "",
      billing_state: order.billing_address?.province || "",
      billing_country: order.billing_address?.country || "",
      billing_email: order.email,
      billing_phone:
        order.customer?.phone ||
        order.billing_address?.phone ||
        "9999999999",
      shipping_is_billing: true,
      order_items: order.line_items.map(i => ({
        name: i.name,
        sku: i.sku || "SKU",
        units: i.quantity,
        selling_price: i.price,
        hsn: 441122,
        category_name: "Food"
      })),
      payment_method: order.financial_status === "paid" ? "Prepaid" : "COD",
      sub_total: order.subtotal_price || 0,
      length: 10,
      breadth: 15,
      height: 20,
      weight: 2.5,
      latitude,
      longitude
    };

    const shiprocketRes = await fetch(
      "https://apiv2.shiprocket.in/v1/external/orders/create/adhoc",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": await getShiprocketAuth()
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await shiprocketRes.json();
    if (!result.shipment_id) throw new Error("Shipment ID missing");

    storePendingOrder(result.shipment_id, order.id);
    console.log(`📦 Stored shipment ${result.shipment_id}`);

  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
  }
});

/* ================== CRON (SUNDAY) ================== */

cron.schedule('0 9 * * 0', async () => {
  console.log("⏰ Sunday Cron Started");

  if (!fs.existsSync(JSON_FILE)) return;
  const orders = JSON.parse(fs.readFileSync(JSON_FILE));
  const remaining = [];

  for (const o of orders) {
    try {
      const res = await fetch(
        "https://apiv2.shiprocket.in/v1/external/courier/assign/awb",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": await getShiprocketAuth()
          },
          body: JSON.stringify({
            shipment_id: o.shipment_id,
            future_pickup_scheduled: getUpcomingMondayDateTime(),
            vehicle_type: 2
          })
        }
      );

      const data = await res.json();
      if (!data.awb_code) throw new Error("AWB failed");

      console.log(`✅ AWB Assigned: ${data.awb_code}`);
    } catch {
      remaining.push(o);
    }
  }

  fs.writeFileSync(JSON_FILE, JSON.stringify(remaining, null, 2));
});

/* ================== START ================== */

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
