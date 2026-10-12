/**
 * The recall gold set baseline (#1154): what each front door served for every case, and the Recall quality it scores.
 *
 * Recorded, never edited: `MYCO_EVAL_RECORD=1 npm run test:parity` writes it, the parity eval holds every release to it,
 * and `tests/myco-server/recall-gold.test.ts` recomputes both headline figures from the record.
 */
export const recallQuality = 0.3962;
export const caseCount = 48;

export const recallBaseline = {
 "version": 1,
 "caseCount": 48,
 "recallQuality": 0.3962,
 "targets": {
  "hosted": {
   "recallQuality": 0.3962,
   "passed": 12,
   "mustNot": {
    "matches": 26,
    "caseIds": [
     "rp-01",
     "rp-09",
     "rp-11",
     "rp-13",
     "rp-14",
     "rp-18",
     "rp-19",
     "rp-22",
     "rp-24",
     "rp-25",
     "rp-27",
     "rp-30",
     "rp-35",
     "rp-37",
     "rp-45",
     "rp-46",
     "rp-47"
    ]
   },
   "cases": {
    "rp-01": {
     "spores": [
      "decision-3235fecb",
      "pattern-951fc175"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-02": {
     "spores": [
      "pattern-951fc175"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-03": {
     "spores": [
      "gotcha-b6ac3ff4"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-04": {
     "spores": [
      "gotcha-ab095250",
      "decision-efda0a7f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-05": {
     "spores": [
      "pattern-55f78337",
      "decision-99ff3f2a",
      "gotcha-4e22ff90",
      "wisdom-0ae9c566"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-06": {
     "spores": [
      "gotcha-348b2516",
      "bug_fix-c1537c4d"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-07": {
     "spores": [
      "decision-2246739a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-08": {
     "spores": [
      "gotcha-05b29309"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-09": {
     "spores": [
      "gotcha-ea1915d6",
      "gotcha-582cfdc6",
      "gotcha-26e00b05"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-10": {
     "spores": [
      "gotcha-0b64daeb"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-11": {
     "spores": [
      "gotcha-05b29309",
      "gotcha-582cfdc6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.25
    },
    "rp-12": {
     "spores": [
      "gotcha-61b34f87",
      "architecture-dbdb80a8",
      "pattern-95c3e7c3",
      "trade_off-8d1a35ee",
      "gotcha-104287ae",
      "wisdom-0ae9c566"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-13": {
     "spores": [
      "gotcha-0c86e21a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-14": {
     "spores": [
      "decision-1af798e2",
      "decision-164b9ec6",
      "gotcha-b6ac3ff4",
      "gotcha-73456cc3",
      "gotcha-0b64daeb"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    },
    "rp-15": {
     "spores": [
      "gotcha-7df77408",
      "trade_off-8d1a35ee"
     ],
     "plans": [],
     "pass": true,
     "graded": 0.5
    },
    "rp-16": {
     "spores": [
      "pattern-1b1b5bdd"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-17": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-18": {
     "spores": [
      "decision-2d352d4a",
      "gotcha-47345f8f",
      "pattern-bca367e0"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-19": {
     "spores": [
      "discovery-86f54e2e",
      "pattern-7f45f303"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-20": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-21": {
     "spores": [
      "gotcha-00fffb04"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-22": {
     "spores": [
      "architecture-dbdb80a8",
      "gotcha-a860dd00",
      "trade_off-eb979ed9",
      "architecture-11db18c6",
      "architecture-aed84f4f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.6
    },
    "rp-23": {
     "spores": [
      "decision-b998c2d8"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-24": {
     "spores": [
      "pattern-4c6f6ae9",
      "gotcha-b6ac3ff4",
      "decision-b9f22e00"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-25": {
     "spores": [
      "decision-941cfb9a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-26": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-27": {
     "spores": [
      "pattern-b4690499",
      "gotcha-5aca3e37"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-28": {
     "spores": [
      "gotcha-2db458a1",
      "architecture-9b116da2",
      "gotcha-efaf7da0",
      "decision-16748312"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-29": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-30": {
     "spores": [
      "gotcha-bb66cfc3",
      "gotcha-a045ca07"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.125
    },
    "rp-31": {
     "spores": [
      "decision-c0b31bb6",
      "decision-30ad1abc",
      "decision-1d95cf73"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.75
    },
    "rp-32": {
     "spores": [
      "bug_fix-b7a0b15d",
      "gotcha-25b5948d",
      "gotcha-5c06ba4c"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-33": {
     "spores": [
      "decision-941cfb9a",
      "pattern-55f78337"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-34": {
     "spores": [
      "pattern-95c3e7c3"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-35": {
     "spores": [
      "decision-efda0a7f",
      "pattern-78fa6e80",
      "decision-bc755ab1",
      "decision-48a78b54",
      "architecture-a95609ec"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1
    },
    "rp-36": {
     "spores": [
      "decision-30ad1abc"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-37": {
     "spores": [
      "architecture-78a3bf84"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-38": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-39": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-40": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-41": {
     "spores": [
      "gotcha-ea1915d6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-42": {
     "spores": [
      "gotcha-47345f8f",
      "decision-32c5111a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-43": {
     "spores": [
      "decision-a7d1bf51",
      "decision-16748312"
     ],
     "plans": [
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ],
     "pass": false,
     "graded": 0.6
    },
    "rp-44": {
     "spores": [
      "trade_off-8d1a35ee"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-45": {
     "spores": [
      "gotcha-89a50d19",
      "decision-358cba44",
      "gotcha-3da46fc2",
      "decision-4e185ae3",
      "gotcha-20d2fea0"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-46": {
     "spores": [
      "pattern-5c2725ae",
      "gotcha-0ce73b33",
      "pattern-bca367e0",
      "gotcha-6699d14a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.125
    },
    "rp-47": {
     "spores": [
      "decision-915db719",
      "pattern-4c6f6ae9",
      "pattern-bca367e0",
      "gotcha-ee798214",
      "architecture-3f7cbad0"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    },
    "rp-48": {
     "spores": [
      "decision-3d502b35",
      "gotcha-ea8bc225"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    }
   }
  },
  "self-hosted": {
   "recallQuality": 0.3962,
   "passed": 12,
   "mustNot": {
    "matches": 26,
    "caseIds": [
     "rp-01",
     "rp-09",
     "rp-11",
     "rp-13",
     "rp-14",
     "rp-18",
     "rp-19",
     "rp-22",
     "rp-24",
     "rp-25",
     "rp-27",
     "rp-30",
     "rp-35",
     "rp-37",
     "rp-45",
     "rp-46",
     "rp-47"
    ]
   },
   "cases": {
    "rp-01": {
     "spores": [
      "decision-3235fecb",
      "pattern-951fc175"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-02": {
     "spores": [
      "pattern-951fc175"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-03": {
     "spores": [
      "gotcha-b6ac3ff4"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-04": {
     "spores": [
      "gotcha-ab095250",
      "decision-efda0a7f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-05": {
     "spores": [
      "pattern-55f78337",
      "decision-99ff3f2a",
      "gotcha-4e22ff90",
      "wisdom-0ae9c566"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-06": {
     "spores": [
      "gotcha-348b2516",
      "bug_fix-c1537c4d"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-07": {
     "spores": [
      "decision-2246739a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-08": {
     "spores": [
      "gotcha-05b29309"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-09": {
     "spores": [
      "gotcha-ea1915d6",
      "gotcha-582cfdc6",
      "gotcha-26e00b05"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-10": {
     "spores": [
      "gotcha-0b64daeb"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-11": {
     "spores": [
      "gotcha-05b29309",
      "gotcha-582cfdc6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.25
    },
    "rp-12": {
     "spores": [
      "gotcha-61b34f87",
      "architecture-dbdb80a8",
      "pattern-95c3e7c3",
      "trade_off-8d1a35ee",
      "gotcha-104287ae",
      "wisdom-0ae9c566"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-13": {
     "spores": [
      "gotcha-0c86e21a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-14": {
     "spores": [
      "decision-1af798e2",
      "decision-164b9ec6",
      "gotcha-b6ac3ff4",
      "gotcha-73456cc3",
      "gotcha-0b64daeb"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    },
    "rp-15": {
     "spores": [
      "gotcha-7df77408",
      "trade_off-8d1a35ee"
     ],
     "plans": [],
     "pass": true,
     "graded": 0.5
    },
    "rp-16": {
     "spores": [
      "pattern-1b1b5bdd"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-17": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-18": {
     "spores": [
      "decision-2d352d4a",
      "gotcha-47345f8f",
      "pattern-bca367e0"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-19": {
     "spores": [
      "discovery-86f54e2e",
      "pattern-7f45f303"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-20": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-21": {
     "spores": [
      "gotcha-00fffb04"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-22": {
     "spores": [
      "architecture-dbdb80a8",
      "gotcha-a860dd00",
      "trade_off-eb979ed9",
      "architecture-11db18c6",
      "architecture-aed84f4f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.6
    },
    "rp-23": {
     "spores": [
      "decision-b998c2d8"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-24": {
     "spores": [
      "pattern-4c6f6ae9",
      "gotcha-b6ac3ff4",
      "decision-b9f22e00"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-25": {
     "spores": [
      "decision-941cfb9a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-26": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-27": {
     "spores": [
      "pattern-b4690499",
      "gotcha-5aca3e37"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-28": {
     "spores": [
      "gotcha-2db458a1",
      "architecture-9b116da2",
      "gotcha-efaf7da0",
      "decision-16748312"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-29": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-30": {
     "spores": [
      "gotcha-bb66cfc3",
      "gotcha-a045ca07"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.125
    },
    "rp-31": {
     "spores": [
      "decision-c0b31bb6",
      "decision-30ad1abc",
      "decision-1d95cf73"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.75
    },
    "rp-32": {
     "spores": [
      "bug_fix-b7a0b15d",
      "gotcha-25b5948d",
      "gotcha-5c06ba4c"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-33": {
     "spores": [
      "decision-941cfb9a",
      "pattern-55f78337"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-34": {
     "spores": [
      "pattern-95c3e7c3"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-35": {
     "spores": [
      "decision-efda0a7f",
      "pattern-78fa6e80",
      "decision-bc755ab1",
      "decision-48a78b54",
      "architecture-a95609ec"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1
    },
    "rp-36": {
     "spores": [
      "decision-30ad1abc"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-37": {
     "spores": [
      "architecture-78a3bf84"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-38": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-39": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-40": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-41": {
     "spores": [
      "gotcha-ea1915d6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-42": {
     "spores": [
      "gotcha-47345f8f",
      "decision-32c5111a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-43": {
     "spores": [
      "decision-a7d1bf51",
      "decision-16748312"
     ],
     "plans": [
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ],
     "pass": false,
     "graded": 0.6
    },
    "rp-44": {
     "spores": [
      "trade_off-8d1a35ee"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-45": {
     "spores": [
      "gotcha-89a50d19",
      "decision-358cba44",
      "gotcha-3da46fc2",
      "decision-4e185ae3",
      "gotcha-20d2fea0"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-46": {
     "spores": [
      "pattern-5c2725ae",
      "gotcha-0ce73b33",
      "pattern-bca367e0",
      "gotcha-6699d14a"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.125
    },
    "rp-47": {
     "spores": [
      "decision-915db719",
      "pattern-4c6f6ae9",
      "pattern-bca367e0",
      "gotcha-ee798214",
      "architecture-3f7cbad0"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    },
    "rp-48": {
     "spores": [
      "decision-3d502b35",
      "gotcha-ea8bc225"
     ],
     "plans": [],
     "pass": true,
     "graded": 1
    }
   }
  }
 }
};
// end of recorded baseline
