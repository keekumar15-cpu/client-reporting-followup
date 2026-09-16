const STAGES = ['Due', 'Sent', 'Invoiced', 'Paid'];

function nextStage(stage) {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
}

function prevStage(stage) {
  const i = STAGES.indexOf(stage);
  return i > 0 ? STAGES[i - 1] : null;
}

function formatMoney(minorUnits, currency) {
  const major = minorUnits / 100;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      maximumFractionDigits: 2,
    }).format(major);
  } catch (e) {
    return `${currency || 'USD'} ${major.toFixed(2)}`;
  }
}

function formatDateLong(d) {
  if (!d) return null;
  const dt = new Date(d);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatMonth(reportMonth) {
  // reportMonth is 'YYYY-MM'
  const [y, m] = reportMonth.split('-').map(Number);
  const dt = new Date(y, m - 1, 1);
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

function dueLabel(row) {
  switch (row.stage) {
    case 'Due':
      return `Report due ${formatDateLong(row.report_due_date)}`;
    case 'Sent':
      return 'Report sent, not yet invoiced';
    case 'Invoiced':
      return row.payment_due_date
        ? `Payment due ${formatDateLong(row.payment_due_date)}`
        : 'Invoice sent, payment date not set';
    case 'Paid':
      return 'Report sent and paid';
    default:
      return '';
  }
}

const ADVANCE_LABEL = {
  Due: 'Mark sent',
  Sent: 'Mark invoiced',
  Invoiced: 'Mark paid',
};

module.exports = {
  STAGES,
  nextStage,
  prevStage,
  formatMoney,
  formatDateLong,
  formatMonth,
  dueLabel,
  ADVANCE_LABEL,
};
