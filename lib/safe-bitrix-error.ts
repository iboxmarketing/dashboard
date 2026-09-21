/** A Bitrix failure whose message was written to be shown to an operator. */
export class SafeBitrixError extends Error {
  code: string;
  statusClass: string | null;

  constructor(code: string, message: string, statusClass: string | null = null) {
    super(message);
    this.code = code;
    this.statusClass = statusClass;
  }
}
