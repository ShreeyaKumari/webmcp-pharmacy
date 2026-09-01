// Mock data for the WebMCP Pharmacy Demo.
//
// Plain-script project (no modules, no bundler), so everything is attached to
// `window` and consumed by app.js and tools.js via globals.
//
// Dates are chosen relative to early September 2026 so the demo shows a mix of
// refill-eligible and not-yet-eligible medications, including one controlled
// substance in each state.

(function () {
  "use strict";

  var MEDICATIONS = [
    {
      id: "med-001",
      name: "Lisinopril",
      dosage: "10mg, once daily",
      patientName: "Aditya's Mom",
      lastFilledDate: "2026-08-05",
      refillEligibleAfterDays: 30,
      isControlledSubstance: false,
      pharmacyLocation: "Main Street Pharmacy"
    },
    {
      id: "med-002",
      name: "Metformin",
      dosage: "500mg, twice daily with meals",
      patientName: "Aditya's Mom",
      lastFilledDate: "2026-07-20",
      refillEligibleAfterDays: 30,
      isControlledSubstance: false,
      pharmacyLocation: "Main Street Pharmacy"
    },
    {
      id: "med-003",
      name: "Alprazolam",
      dosage: "0.5mg, as needed for anxiety",
      patientName: "Aditya's Mom",
      lastFilledDate: "2026-08-02",
      refillEligibleAfterDays: 30,
      isControlledSubstance: true,
      pharmacyLocation: "Main Street Pharmacy"
    },
    {
      id: "med-004",
      name: "Oxycodone",
      dosage: "5mg, every 6 hours as needed for pain",
      patientName: "Aditya's Mom",
      lastFilledDate: "2026-08-25",
      refillEligibleAfterDays: 30,
      isControlledSubstance: true,
      pharmacyLocation: "Riverside Specialty Pharmacy"
    },
    {
      id: "med-005",
      name: "Atorvastatin",
      dosage: "20mg, once daily at bedtime",
      patientName: "Aditya's Mom",
      lastFilledDate: "2026-06-15",
      refillEligibleAfterDays: 60,
      isControlledSubstance: false,
      pharmacyLocation: "Main Street Pharmacy"
    }
  ];

  // Hardcoded interaction table for a future check_drug_interactions tool.
  // Not consumed by any tool yet — data only, as requested.
  var DRUG_INTERACTIONS = [
    {
      medA: "med-001",
      medB: "med-002",
      severity: "moderate",
      note:
        "May increase the risk of low blood sugar and, rarely, lactic acidosis. " +
        "Monitor blood glucose and kidney function."
    },
    {
      medA: "med-003",
      medB: "med-004",
      severity: "severe",
      note:
        "Combining a benzodiazepine with an opioid can cause profound sedation, " +
        "respiratory depression, and death. Avoid unless specifically directed " +
        "by the prescriber."
    },
    {
      medA: "med-001",
      medB: "med-005",
      severity: "minor",
      note:
        "No clinically significant interaction expected; occasional reports of " +
        "muscle aches when taken together."
    }
  ];

  window.MEDICATIONS = MEDICATIONS;
  window.DRUG_INTERACTIONS = DRUG_INTERACTIONS;
})();
