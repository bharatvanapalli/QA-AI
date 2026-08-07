export function shouldShowDataRowUi(row, totalRows) {
  const singleInlineRow = Number(totalRows) === 1
    && String(row?.dataSetName || row?.setName || '').trim().toLowerCase() === 'inlinetext';
  return !singleInlineRow;
}
