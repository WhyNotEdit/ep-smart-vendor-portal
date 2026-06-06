// EP Smart Vendor Portal — Cloud Sync API
// GET  /api/state                → returns full state (vendors + work orders)
// POST /api/state action=replace → full state replace
// POST /api/state action=addVendor
// POST /api/state action=updateVendor
// POST /api/state action=addWorkOrder
// POST /api/state action=updateWOStatus   → vendor updates status label
// POST /api/state action=markPaid         → Elio marks WO paid
// POST /api/state action=addWOFile        → attach invoice/photo note

import { kv } from '@vercel/kv';

const STATE_KEY = 'ep:vendor:v1';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function emptyState() {
  return {
    vendors: [],
    workOrders: [],
    updatedAt: null,
    updatedBy: null,
  };
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET ──────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const state = (await kv.get(STATE_KEY)) || emptyState();
      return res.status(200).json(state);
    }

    // ── POST ─────────────────────────────────────────────────────────
    if (req.method === 'POST') {
      const { action, payload } = req.body || {};

      // Full replace (import / reset)
      if (!action || action === 'replace') {
        const next = {
          vendors: payload?.vendors || [],
          workOrders: payload?.workOrders || [],
          updatedAt: new Date().toISOString(),
          updatedBy: payload?.updatedBy || 'unknown',
        };
        await kv.set(STATE_KEY, next);
        return res.status(200).json(next);
      }

      // All atomic actions — read → mutate → write
      const state = (await kv.get(STATE_KEY)) || emptyState();

      // ── addVendor ──────────────────────────────────────────────────
      if (action === 'addVendor') {
        const { vendor } = payload;
        if (!vendor || !vendor.id) return res.status(400).json({ error: 'vendor.id required' });
        const exists = state.vendors.find(v => v.id === vendor.id);
        if (exists) return res.status(409).json({ error: 'Vendor ID already exists' });
        vendor.createdAt = new Date().toISOString();
        state.vendors.push(vendor);
      }

      // ── updateVendor ───────────────────────────────────────────────
      else if (action === 'updateVendor') {
        const { vendorId, updates } = payload;
        const idx = state.vendors.findIndex(v => v.id === vendorId);
        if (idx === -1) return res.status(404).json({ error: 'Vendor not found' });
        state.vendors[idx] = { ...state.vendors[idx], ...updates, updatedAt: new Date().toISOString() };
      }

      // ── addWorkOrder ───────────────────────────────────────────────
      else if (action === 'addWorkOrder') {
        const { workOrder } = payload;
        if (!workOrder || !workOrder.id) return res.status(400).json({ error: 'workOrder.id required' });
        const exists = state.workOrders.find(w => w.id === workOrder.id);
        if (exists) return res.status(409).json({ error: 'Work order ID already exists' });
        workOrder.createdAt = new Date().toISOString();
        workOrder.paid = false;
        workOrder.status = 'active';
        workOrder.statusLabel = 'In progress';
        workOrder.files = [];
        workOrder.quote = '';
        state.workOrders.unshift(workOrder);
      }

      // ── updateWOStatus (vendor side) ───────────────────────────────
      else if (action === 'updateWOStatus') {
        const { woId, statusLabel, who } = payload;
        const wo = state.workOrders.find(w => w.id === woId);
        if (!wo) return res.status(404).json({ error: 'Work order not found' });
        wo.statusLabel = statusLabel;
        wo.status = statusLabel === 'Complete' ? 'complete' : 'active';
        wo.statusUpdatedAt = new Date().toISOString();
        wo.statusUpdatedBy = who || 'vendor';
      }

      // ── updateWOQuote (vendor side) ────────────────────────────────
      else if (action === 'updateWOQuote') {
        const { woId, quote, who } = payload;
        const wo = state.workOrders.find(w => w.id === woId);
        if (!wo) return res.status(404).json({ error: 'Work order not found' });
        wo.quote = quote;
        wo.quoteUpdatedAt = new Date().toISOString();
        wo.quoteUpdatedBy = who || 'vendor';
      }

      // ── markPaid (Elio only) ───────────────────────────────────────
      else if (action === 'markPaid') {
        const { woId, who } = payload;
        const wo = state.workOrders.find(w => w.id === woId);
        if (!wo) return res.status(404).json({ error: 'Work order not found' });
        if (wo.statusLabel !== 'Complete') {
          return res.status(400).json({ error: 'Vendor must mark complete first' });
        }
        wo.paid = true;
        wo.paidAt = new Date().toISOString();
        wo.paidBy = who || 'master';
      }

      // ── addWOFile (vendor uploads invoice/photo reference) ─────────
      else if (action === 'addWOFile') {
        const { woId, file } = payload;
        const wo = state.workOrders.find(w => w.id === woId);
        if (!wo) return res.status(404).json({ error: 'Work order not found' });
        if (!wo.files) wo.files = [];
        wo.files.push({ ...file, uploadedAt: new Date().toISOString() });
      }

      // ── deleteWorkOrder (Elio only) ────────────────────────────────
      else if (action === 'deleteWorkOrder') {
        const { woId } = payload;
        state.workOrders = state.workOrders.filter(w => w.id !== woId);
      }

      else {
        return res.status(400).json({ error: 'Unknown action: ' + action });
      }

      state.updatedAt = new Date().toISOString();
      state.updatedBy = payload?.who || 'unknown';
      await kv.set(STATE_KEY, state);
      return res.status(200).json(state);
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (err) {
    console.error('EP Vendor API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
