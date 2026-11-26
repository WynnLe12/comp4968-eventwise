/** The MVP tracks dollar amounts without selecting or converting currencies. */
export function formatContractAmount(value: string | null): string {
  if (value === null) return "Not set";
  const [whole, cents] = value.split(".");
  return "$" + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + cents;
}
