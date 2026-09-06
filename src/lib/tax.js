// Optional per-property tax on website-checkout orders (pro shop +
// restaurant web ordering) -- see migrate-2026-09-06-order-tax.sql. Applies
// to the items subtotal only, not shipping/delivery. tax_inclusive means the
// catalogue's prices already include tax (the tax portion is backed out of
// itemsSubtotal, not added); otherwise tax is added on top of it.
//
// Snapshotted onto the order at creation time (the caller stores the
// returned taxAmount), same reasoning as item unit_price/subtotal -- a later
// change to property.tax_rate must never alter an already-placed order.
function computeOrderTax(property, itemsSubtotal) {
  if (!property?.tax_enabled || !property.tax_rate) return { taxAmount: 0, totalExtra: 0 };
  const rate = Number(property.tax_rate) / 100;
  if (property.tax_inclusive) {
    const taxAmount = Math.round((itemsSubtotal - itemsSubtotal / (1 + rate)) * 100) / 100;
    return { taxAmount, totalExtra: 0 };
  }
  const taxAmount = Math.round(itemsSubtotal * rate * 100) / 100;
  return { taxAmount, totalExtra: taxAmount };
}

module.exports = { computeOrderTax };
