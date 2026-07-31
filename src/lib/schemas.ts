/**
 * Document type definitions.
 *
 * This is the heart of a real IDP config: for each kind of document you care
 * about, you declare the fields you want, whether they're required, and how to
 * validate them. Everything downstream (the prompt, the review UI, the
 * validation rules) is generated from this file — add a doc type here and the
 * rest of the system picks it up.
 */

export type FieldType = "string" | "date" | "money" | "number";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  /** Shown to the model. Be specific — this is your extraction prompt. */
  hint: string;
}

export interface DocTypeDef {
  key: string;
  label: string;
  /** Shown to the model during classification. */
  description: string;
  fields: FieldDef[];
  /** Whether to ask the model for line-item tables. */
  expectsLineItems: boolean;
}

export const DOC_TYPES: DocTypeDef[] = [
  {
    key: "invoice",
    label: "Invoice",
    description:
      "A bill issued by a seller requesting payment, usually with an invoice number, line items, subtotal, tax and total due.",
    expectsLineItems: true,
    fields: [
      { key: "invoiceNumber", label: "Invoice number", type: "string", required: true, hint: "The seller's invoice identifier, e.g. INV-2043." },
      { key: "invoiceDate", label: "Invoice date", type: "date", required: true, hint: "Date the invoice was issued, as ISO YYYY-MM-DD." },
      { key: "dueDate", label: "Due date", type: "date", required: false, hint: "Payment due date, as ISO YYYY-MM-DD." },
      { key: "vendorName", label: "Vendor", type: "string", required: true, hint: "Legal name of the company issuing the invoice." },
      { key: "billToName", label: "Bill to", type: "string", required: false, hint: "Name of the customer being billed." },
      { key: "subtotal", label: "Subtotal", type: "money", required: false, hint: "Pre-tax total, digits and decimal point only." },
      { key: "tax", label: "Tax", type: "money", required: false, hint: "Total tax amount, digits and decimal point only." },
      { key: "total", label: "Total due", type: "money", required: true, hint: "Final amount payable, digits and decimal point only." },
      { key: "currency", label: "Currency", type: "string", required: false, hint: "ISO 4217 code, e.g. USD." },
      { key: "poNumber", label: "PO number", type: "string", required: false, hint: "Referenced purchase order number, if any." },
    ],
  },
  {
    key: "receipt",
    label: "Receipt",
    description:
      "Proof of a completed payment, typically from a retail or restaurant point of sale. Usually has a merchant name, timestamp and total paid.",
    expectsLineItems: true,
    fields: [
      { key: "merchantName", label: "Merchant", type: "string", required: true, hint: "Name of the store or restaurant." },
      { key: "transactionDate", label: "Date", type: "date", required: true, hint: "Date of purchase, as ISO YYYY-MM-DD." },
      { key: "subtotal", label: "Subtotal", type: "money", required: false, hint: "Pre-tax total, digits and decimal point only." },
      { key: "tax", label: "Tax", type: "money", required: false, hint: "Tax charged, digits and decimal point only." },
      { key: "tip", label: "Tip", type: "money", required: false, hint: "Gratuity, digits and decimal point only." },
      { key: "total", label: "Total paid", type: "money", required: true, hint: "Final amount paid, digits and decimal point only." },
      { key: "paymentMethod", label: "Payment method", type: "string", required: false, hint: "e.g. Visa ending 4242, cash." },
    ],
  },
  {
    key: "purchase_order",
    label: "Purchase order",
    description:
      "A buyer's authorisation to purchase goods or services, issued before an invoice. Has a PO number and ordered quantities.",
    expectsLineItems: true,
    fields: [
      { key: "poNumber", label: "PO number", type: "string", required: true, hint: "The purchase order identifier." },
      { key: "orderDate", label: "Order date", type: "date", required: true, hint: "Date the order was placed, as ISO YYYY-MM-DD." },
      { key: "buyerName", label: "Buyer", type: "string", required: true, hint: "Organisation placing the order." },
      { key: "supplierName", label: "Supplier", type: "string", required: false, hint: "Organisation fulfilling the order." },
      { key: "total", label: "Order total", type: "money", required: false, hint: "Total order value, digits and decimal point only." },
      { key: "deliveryDate", label: "Requested delivery", type: "date", required: false, hint: "Requested delivery date, as ISO YYYY-MM-DD." },
    ],
  },
];

/** Fallback when the classifier can't place the document. */
export const UNKNOWN_DOC_TYPE: DocTypeDef = {
  key: "unknown",
  label: "Unknown",
  description: "Anything that doesn't match a known type.",
  expectsLineItems: false,
  fields: [],
};

export function getDocType(key: string | null | undefined): DocTypeDef {
  if (!key) return UNKNOWN_DOC_TYPE;
  return DOC_TYPES.find((t) => t.key === key) ?? UNKNOWN_DOC_TYPE;
}

/**
 * Anything below this is surfaced to a human. Raising it sends more documents
 * to review (safer, slower); lowering it auto-approves more (faster, riskier).
 * This single number is the main cost/accuracy dial in an IDP system.
 */
export const CONFIDENCE_THRESHOLD = Number(
  process.env.CONFIDENCE_THRESHOLD ?? "0.85",
);
