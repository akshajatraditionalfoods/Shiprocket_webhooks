require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto'); // Added for HMAC verification
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

const SHIPROCKET_EMAIL = process.env.SHIPROCKET_EMAIL;
const SHIPROCKET_PASSWORD = process.env.SHIPROCKET_PASSWORD;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

const JSON_FILE = path.join(__dirname, 'pending-orders.json');
let shiprocketToken = "";

async function fetchShiprocketToken() {
  try {
    const res = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: SHIPROCKET_EMAIL,
        password: SHIPROCKET_PASSWORD
      })
    });

    const text = await res.text(); // first read as text
    console.log("Raw Shiprocket Response:", text);

    const data = JSON.parse(text); // then parse
    shiprocketToken = "Bearer " + data.token;
    console.log("✅ Shiprocket token fetched");
    console.log("Token:", shiprocketToken);
  } catch (err) {
    console.error("❌ Shiprocket token error:", err.message);
  }
}

fetchShiprocketToken();

app.use('/webhooks/orders_create', bodyParser.raw({ type: 'application/json' }));

app.use(bodyParser.json());

app.get('/order', (req, res) => {
  res.send("📦 Order API is live");
});

// Store shipment ID locally
function storePendingOrder(shipment_id, orderInfo) {
  let orders = [];
  if (fs.existsSync(JSON_FILE)) {
    orders = JSON.parse(fs.readFileSync(JSON_FILE));
  }
  orders.push({
    shipment_id,
    order_id: orderInfo.order_id,
    created_at: new Date().toISOString()
  });
  fs.writeFileSync(JSON_FILE, JSON.stringify(orders, null, 2));
}

function getUpcomingMondayDateTime() {
  const now = new Date();
  const monday = new Date();

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  monday.setDate(now.getDate() + daysUntilMonday);
  monday.setHours(4, 0, 0, 0);  

  return monday.toISOString().slice(0, 19).replace('T', ' ');
}

// Shopify HMAC Verification
function verifyShopifyHmac(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  if (!hmacHeader) return false;

  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

app.post('/webhooks/orders_create', async (req, res) => {
  // 🔒 Verify HMAC
  if (!verifyShopifyHmac(req)) {
    console.error("❌ Invalid Shopify HMAC");
    return res.status(401).send("Unauthorized");
  }

  console.log('✅ New Shopify Order Received');

  const order = JSON.parse(req.body.toString()); // parse raw body

  const deliveryInfo = {};
  if (Array.isArray(order.note_attributes)) {
    order.note_attributes.forEach(attr => {
      deliveryInfo[attr.name] = attr.value;
    });
  }

  const deliveryDate = deliveryInfo["Delivery Date"] || "";
  const deliveryTime = deliveryInfo["Delivery Time"] || "";
  const deliveryDay = deliveryInfo["Delivery Day"] || "";
  const customerTimeZone = deliveryInfo["Customer TimeZone"] || "Asia/Calcutta";

  const zip = order.billing_address?.zip || "";
  let latitude = "0.0";
  let longitude = "0.0";

  try {
    const geoRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${zip}&key=${GOOGLE_MAPS_API_KEY}`);
    const geoData = await geoRes.json();

    if (geoData.status === "OK" && geoData.results.length > 0) {
      latitude = geoData.results[0].geometry.location.lat.toString();
      longitude = geoData.results[0].geometry.location.lng.toString();
      console.log(`📍 ZIP ${zip} → lat: ${latitude}, lng: ${longitude}`);
    } else {
      console.warn("⚠️ Could not fetch coordinates");
    }
  } catch (err) {
    console.error("🌐 Geocoding error:", err.message);
  }

  const payload = {
    order_id: order.id.toString(),
    order_date: order.created_at,
    pickup_location: "Home-1",
    channel_id: "",
    comment: `Delivery on ${deliveryDate} (${deliveryDay}) at ${deliveryTime} [${customerTimeZone}]`,
    billing_customer_name: order.billing_address?.first_name || "Unknown",
    billing_last_name: order.billing_address?.last_name || "",
    billing_address: order.billing_address?.address1 || "",
    billing_address_2: order.billing_address?.address2 || "",
    billing_city: order.billing_address?.city || "",
    billing_pincode: order.billing_address?.zip || "",
    billing_state: order.billing_address?.province || "",
    billing_country: order.billing_address?.country || "",
    billing_email: order.email || "",
    billing_phone: order.customer?.phone || "7672499601",
    shipping_is_billing: true,
    order_items: order.line_items.map(item => ({
      name: item.name,
      sku: item.sku || "defaultsku",
      units: item.quantity,
      selling_price: item.price,
      hsn: 441122,
      category_name: "Food"
    })),
    payment_method: order.financial_status === "paid" ? "Prepaid" : "COD",
    shipping_charges: 0,
    giftwrap_charges: 0,
    transaction_charges: 0,
    total_discount: 0,
    sub_total: order.subtotal_price || 0,
    length: 10,
    breadth: 15,
    height: 20,
    weight: 2.5,
    shipping_method: "HL",
    latitude,
    longitude
  };

  try {
    // const response = await fetch("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
    //   method: "POST",
    //   headers: {
    //     "Content-Type": "application/json",
    //     "Authorization": shiprocketToken
    //   },
    //   body: JSON.stringify(payload)
    // });

    // const data = await response.json();
    // console.log("🚚 Shiprocket Order Response:", data);
    const response = await fetch("https://apiv2.shiprocket.in/v1/external/orders/create/adhoc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": shiprocketToken
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    console.log("Raw Shiprocket Order Response:", text);

    const data = JSON.parse(text);


    if (!data.shipment_id) {
      throw new Error("❌ Shipment ID not returned from Shiprocket");
    }

    storePendingOrder(data.shipment_id, { order_id: order.id });
    console.log("📦 Stored for Sunday scheduling");
    res.status(200).send("Order received and scheduled");
  } catch (error) {
    console.error("❌ Shiprocket order error:", error.message);
    res.status(500).send("Shiprocket order failed");
  }
});


cron.schedule('0 00 2 * * 0', async () => {
  console.log("⏰ Sunday Cron: Assign AWB");

  if (!fs.existsSync(JSON_FILE)) return;

  const orders = JSON.parse(fs.readFileSync(JSON_FILE));
  const remainingOrders = [];

  for (const order of orders) {
    try {
      const res = await fetch("https://apiv2.shiprocket.in/v1/external/courier/assign/awb", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": shiprocketToken
        },
        body: JSON.stringify({
          shipment_id: order.shipment_id,
          future_pickup_scheduled: getUpcomingMondayDateTime(),
          courier_id: "",
          vehicle_type: 2
        })
      });

      const result = await res.json();

      if (res.ok && result.awb_code) {
        console.log(`✅ AWB Assigned: ${result.awb_code} for shipment ${order.shipment_id}`);
      } else {
        console.warn(`⚠️ Failed for ${order.shipment_id}:`, result);
        remainingOrders.push(order);
      }
    } catch (err) {
      console.error(`❌ Error for ${order.shipment_id}:`, err.message);
      remainingOrders.push(order);
    }
  }

  fs.writeFileSync(JSON_FILE, JSON.stringify(remainingOrders, null, 2));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
