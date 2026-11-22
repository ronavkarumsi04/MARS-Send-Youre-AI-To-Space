export class NoEligibleModelError extends Error {
  constructor() {
    super(
      "No eligible configured model; configure a tool-capable free model or explicitly select a priced, user-authorized paid model.",
    );
    this.name = "NoEligibleModelError";
  }
}
