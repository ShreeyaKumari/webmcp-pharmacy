// Mock data for the WebMCP Pharmacy Demo.
//
// Plain-script project (no modules, no bundler), so everything is attached to
// `window` and consumed by app.js and tools.js via globals.
//
// lastFilledDate values are computed relative to today at load time rather than
// hardcoded, so the intended demo spread — some medications eligible, some not
// yet, one controlled substance in each state — holds on whatever day the page
// is opened. Each daysAgo(N) is paired with that medication's own
// refillEligibleAfterDays so the resulting state is unambiguous:
//
//   med-001  filled  5d ago, window 30d  ->  not eligible for another 25 days
//   med-002  filled 45d ago, window 30d  ->  eligible (15 days clear)
//   med-003  filled 40d ago, window 30d  ->  eligible, controlled (approval block)
//   med-004  filled  3d ago, window 30d  ->  not eligible, controlled
//   med-005  filled 50d ago, window 45d  ->  eligible (5 days clear)

(function () {
  "use strict";

  // Returns the ISO date (YYYY-MM-DD) N days before today.
  // Arithmetic is done in UTC to match the date handling in app.js, so the
  // computed dates never shift by a day depending on the viewer's timezone.
  function daysAgo(n) {
    var now = new Date();
    var d = new Date(
      Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
    );
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().split("T")[0]; // "YYYY-MM-DD"
  }

  var MEDICATIONS = [
    {
      id: "med-001",
      name: "Lisinopril",
      dosage: "10mg, once daily",
      patientName: "Meera Sharma",
      lastFilledDate: daysAgo(5),
      refillEligibleAfterDays: 30,
      isControlledSubstance: false,
      pharmacyLocation: "Main Street Pharmacy"
    },
    {
      id: "med-002",
      name: "Metformin",
      dosage: "500mg, twice daily with meals",
      patientName: "Meera Sharma",
      lastFilledDate: daysAgo(45),
      refillEligibleAfterDays: 30,
      isControlledSubstance: false,
      pharmacyLocation: "Main Street Pharmacy"
    },
    {
      id: "med-003",
      name: "Alprazolam",
      dosage: "0.5mg, as needed for anxiety",
      patientName: "Meera Sharma",
      lastFilledDate: daysAgo(40),
      refillEligibleAfterDays: 30,
      isControlledSubstance: true,
      pharmacyLocation: "Main Street Pharmacy"
    },
    {
      id: "med-004",
      name: "Oxycodone",
      dosage: "5mg, every 6 hours as needed for pain",
      patientName: "Meera Sharma",
      lastFilledDate: daysAgo(3),
      refillEligibleAfterDays: 30,
      isControlledSubstance: true,
      pharmacyLocation: "Riverside Specialty Pharmacy"
    },
    {
      id: "med-005",
      name: "Atorvastatin",
      dosage: "20mg, once daily at bedtime",
      patientName: "Meera Sharma",
      lastFilledDate: daysAgo(50),
      // 45-day window so daysAgo(50) is comfortably past it; a 60-day window
      // would have made this medication NOT eligible.
      refillEligibleAfterDays: 45,
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
