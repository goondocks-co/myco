/**
 * The recall gold set baseline (#1154): what each front door served for every case, and the Recall quality it scores.
 *
 * Recorded, never edited: `MYCO_EVAL_RECORD=1 npm run test:parity` writes it, the parity eval holds every release to it,
 * and `tests/myco-server/recall-gold.test.ts` recomputes both headline figures from the record.
 */
export const recallQuality = 0.3979;
export const caseCount = 48;

export const recallBaseline = {
 "version": 1,
 "caseCount": 48,
 "recallQuality": 0.3979,
 "targets": {
  "hosted": {
   "recallQuality": 0.3979,
   "passed": 9,
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
      "gotcha-b6ac3ff4",
      "decision-5e140083",
      "gotcha-7a7dfc75",
      "gotcha-61b34f87",
      "gotcha-993a341d",
      "pattern-70522f4f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-04": {
     "spores": [
      "gotcha-ab095250",
      "decision-efda0a7f",
      "decision-941cfb9a",
      "pattern-f9df6f2b",
      "gotcha-77e66874",
      "decision-2d352d4a"
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
      "wisdom-0ae9c566",
      "decision-9cc38702"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-06": {
     "spores": [
      "gotcha-348b2516",
      "gotcha-0c86e21a",
      "bug_fix-baa434d4",
      "bug_fix-c1537c4d",
      "architecture-d57cea09"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
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
      "gotcha-05b29309",
      "gotcha-511712b9",
      "trade_off-a0713aa2",
      "trade_off-8d1a35ee"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-09": {
     "spores": [
      "gotcha-ea1915d6",
      "gotcha-582cfdc6",
      "gotcha-26e00b05",
      "architecture-95bccc39",
      "gotcha-61b34f87",
      "wisdom-b4f88d04"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-10": {
     "spores": [
      "gotcha-0b64daeb",
      "gotcha-6668d672",
      "gotcha-05b29309",
      "gotcha-7f12b7a8",
      "gotcha-077d59de",
      "gotcha-f0d3789c"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-11": {
     "spores": [
      "gotcha-05b29309",
      "gotcha-7f12b7a8",
      "gotcha-582cfdc6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.6667
    },
    "rp-12": {
     "spores": [
      "gotcha-61b34f87",
      "architecture-dbdb80a8",
      "pattern-95c3e7c3",
      "trade_off-8d1a35ee",
      "gotcha-104287ae",
      "pattern-55f78337"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-13": {
     "spores": [
      "gotcha-0c86e21a",
      "gotcha-e5bf1d75",
      "gotcha-777597e9",
      "gotcha-9e60325f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-14": {
     "spores": [
      "decision-1af798e2",
      "decision-164b9ec6",
      "gotcha-b6ac3ff4",
      "gotcha-73456cc3",
      "gotcha-0b64daeb",
      "gotcha-511712b9"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-15": {
     "spores": [
      "gotcha-7df77408",
      "discovery-86f54e2e",
      "trade_off-8d1a35ee",
      "gotcha-a860dd00",
      "trade_off-a0713aa2"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.2
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
      "bug_fix-274c91ec",
      "pattern-bca367e0",
      "gotcha-8c0e5692"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.2
    },
    "rp-19": {
     "spores": [
      "discovery-86f54e2e",
      "pattern-7f45f303",
      "decision-b998c2d8",
      "gotcha-e7daaa0a",
      "gotcha-234b6c58"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.0667
    },
    "rp-20": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-21": {
     "spores": [
      "gotcha-00fffb04",
      "decision-941cfb9a",
      "pattern-951fc175"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-22": {
     "spores": [
      "architecture-dbdb80a8",
      "gotcha-ea1915d6",
      "gotcha-a860dd00",
      "trade_off-8d1a35ee",
      "trade_off-eb979ed9",
      "architecture-11db18c6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-23": {
     "spores": [
      "decision-b998c2d8",
      "gotcha-6f593485",
      "gotcha-b89e5f5a",
      "wisdom-b4f88d04"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-24": {
     "spores": [
      "pattern-4c6f6ae9",
      "gotcha-b6ac3ff4",
      "gotcha-9e60325f",
      "gotcha-36b3fda3",
      "gotcha-c3919ebd",
      "decision-b9f22e00"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-25": {
     "spores": [
      "decision-941cfb9a",
      "gotcha-05b29309",
      "decision-56ec66c9",
      "pattern-f9df6f2b"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.25
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
      "decision-88ebab9d",
      "gotcha-9e60325f",
      "gotcha-a045ca07",
      "discovery-6c072e31",
      "gotcha-ad9a0794"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-31": {
     "spores": [
      "decision-c0b31bb6",
      "decision-30ad1abc",
      "decision-1d95cf73",
      "pattern-01feebae",
      "gotcha-0ac58ea7"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.8
    },
    "rp-32": {
     "spores": [
      "bug_fix-b7a0b15d",
      "gotcha-25b5948d",
      "gotcha-5c06ba4c",
      "decision-ccf7d50a"
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
      "pattern-95c3e7c3",
      "pattern-78fa6e80",
      "decision-c0b31bb6",
      "wisdom-0ae9c566",
      "decision-48a78b54",
      "architecture-0605a2b5"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-35": {
     "spores": [
      "decision-efda0a7f",
      "pattern-78fa6e80",
      "pattern-95c3e7c3",
      "decision-bc755ab1",
      "decision-48a78b54",
      "architecture-a95609ec"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.0833
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
      "architecture-78a3bf84",
      "gotcha-d5abdac1",
      "decision-1af798e2",
      "pattern-e751aa7c",
      "gotcha-36b3fda3"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.2
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
      "gotcha-ea1915d6",
      "gotcha-d5abdac1",
      "pattern-70522f4f",
      "gotcha-7f12b7a8",
      "gotcha-25b5948d"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.6
    },
    "rp-42": {
     "spores": [
      "gotcha-47345f8f",
      "decision-32c5111a",
      "gotcha-8a800920",
      "gotcha-777597e9"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-43": {
     "spores": [
      "decision-a7d1bf51",
      "pattern-55f78337",
      "decision-16748312",
      "decision-48a78b54",
      "pattern-95c3e7c3"
     ],
     "plans": [
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ],
     "pass": true,
     "graded": 0.8333
    },
    "rp-44": {
     "spores": [
      "trade_off-8d1a35ee",
      "trade_off-a0713aa2",
      "gotcha-104287ae",
      "decision-491969db",
      "bug_fix-9d4bcb06"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    },
    "rp-45": {
     "spores": [
      "gotcha-89a50d19",
      "decision-358cba44",
      "gotcha-3da46fc2",
      "pattern-e6b83287",
      "gotcha-348b2516",
      "decision-4e185ae3"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-46": {
     "spores": [
      "pattern-5c2725ae",
      "gotcha-0ce73b33",
      "pattern-bca367e0",
      "gotcha-8a800920",
      "gotcha-6699d14a",
      "decision-099a9b1e"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-47": {
     "spores": [
      "decision-915db719",
      "pattern-4c6f6ae9",
      "pattern-bca367e0",
      "gotcha-ee798214",
      "architecture-3f7cbad0",
      "architecture-9b116da2"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-48": {
     "spores": [
      "decision-3d502b35",
      "gotcha-ea8bc225",
      "decision-3235fecb",
      "decision-7750ee22",
      "decision-5ec5b3ba"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    }
   }
  },
  "self-hosted": {
   "recallQuality": 0.3979,
   "passed": 9,
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
      "gotcha-b6ac3ff4",
      "decision-5e140083",
      "gotcha-7a7dfc75",
      "gotcha-61b34f87",
      "gotcha-993a341d",
      "pattern-70522f4f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-04": {
     "spores": [
      "gotcha-ab095250",
      "decision-efda0a7f",
      "decision-941cfb9a",
      "pattern-f9df6f2b",
      "gotcha-77e66874",
      "decision-2d352d4a"
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
      "wisdom-0ae9c566",
      "decision-9cc38702"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-06": {
     "spores": [
      "gotcha-348b2516",
      "gotcha-0c86e21a",
      "bug_fix-baa434d4",
      "bug_fix-c1537c4d",
      "architecture-d57cea09"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
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
      "gotcha-05b29309",
      "gotcha-511712b9",
      "trade_off-a0713aa2",
      "trade_off-8d1a35ee"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-09": {
     "spores": [
      "gotcha-ea1915d6",
      "gotcha-582cfdc6",
      "gotcha-26e00b05",
      "architecture-95bccc39",
      "gotcha-61b34f87",
      "wisdom-b4f88d04"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-10": {
     "spores": [
      "gotcha-0b64daeb",
      "gotcha-6668d672",
      "gotcha-05b29309",
      "gotcha-7f12b7a8",
      "gotcha-077d59de",
      "gotcha-f0d3789c"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-11": {
     "spores": [
      "gotcha-05b29309",
      "gotcha-7f12b7a8",
      "gotcha-582cfdc6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.6667
    },
    "rp-12": {
     "spores": [
      "gotcha-61b34f87",
      "architecture-dbdb80a8",
      "pattern-95c3e7c3",
      "trade_off-8d1a35ee",
      "gotcha-104287ae",
      "pattern-55f78337"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-13": {
     "spores": [
      "gotcha-0c86e21a",
      "gotcha-e5bf1d75",
      "gotcha-777597e9",
      "gotcha-9e60325f"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-14": {
     "spores": [
      "decision-1af798e2",
      "decision-164b9ec6",
      "gotcha-b6ac3ff4",
      "gotcha-73456cc3",
      "gotcha-0b64daeb",
      "gotcha-511712b9"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-15": {
     "spores": [
      "gotcha-7df77408",
      "discovery-86f54e2e",
      "trade_off-8d1a35ee",
      "gotcha-a860dd00",
      "trade_off-a0713aa2"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.2
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
      "bug_fix-274c91ec",
      "pattern-bca367e0",
      "gotcha-8c0e5692"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.2
    },
    "rp-19": {
     "spores": [
      "discovery-86f54e2e",
      "pattern-7f45f303",
      "decision-b998c2d8",
      "gotcha-e7daaa0a",
      "gotcha-234b6c58"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.0667
    },
    "rp-20": {
     "spores": [],
     "plans": [],
     "pass": true,
     "graded": 1
    },
    "rp-21": {
     "spores": [
      "gotcha-00fffb04",
      "decision-941cfb9a",
      "pattern-951fc175"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-22": {
     "spores": [
      "architecture-dbdb80a8",
      "gotcha-ea1915d6",
      "gotcha-a860dd00",
      "trade_off-8d1a35ee",
      "trade_off-eb979ed9",
      "architecture-11db18c6"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-23": {
     "spores": [
      "decision-b998c2d8",
      "gotcha-6f593485",
      "gotcha-b89e5f5a",
      "wisdom-b4f88d04"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-24": {
     "spores": [
      "pattern-4c6f6ae9",
      "gotcha-b6ac3ff4",
      "gotcha-9e60325f",
      "gotcha-36b3fda3",
      "gotcha-c3919ebd",
      "decision-b9f22e00"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-25": {
     "spores": [
      "decision-941cfb9a",
      "gotcha-05b29309",
      "decision-56ec66c9",
      "pattern-f9df6f2b"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.25
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
      "decision-88ebab9d",
      "gotcha-9e60325f",
      "gotcha-a045ca07",
      "discovery-6c072e31",
      "gotcha-ad9a0794"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-31": {
     "spores": [
      "decision-c0b31bb6",
      "decision-30ad1abc",
      "decision-1d95cf73",
      "pattern-01feebae",
      "gotcha-0ac58ea7"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.8
    },
    "rp-32": {
     "spores": [
      "bug_fix-b7a0b15d",
      "gotcha-25b5948d",
      "gotcha-5c06ba4c",
      "decision-ccf7d50a"
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
      "pattern-95c3e7c3",
      "pattern-78fa6e80",
      "decision-c0b31bb6",
      "wisdom-0ae9c566",
      "decision-48a78b54",
      "architecture-0605a2b5"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.5
    },
    "rp-35": {
     "spores": [
      "decision-efda0a7f",
      "pattern-78fa6e80",
      "pattern-95c3e7c3",
      "decision-bc755ab1",
      "decision-48a78b54",
      "architecture-a95609ec"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.0833
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
      "architecture-78a3bf84",
      "gotcha-d5abdac1",
      "decision-1af798e2",
      "pattern-e751aa7c",
      "gotcha-36b3fda3"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.2
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
      "gotcha-ea1915d6",
      "gotcha-d5abdac1",
      "pattern-70522f4f",
      "gotcha-7f12b7a8",
      "gotcha-25b5948d"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.6
    },
    "rp-42": {
     "spores": [
      "gotcha-47345f8f",
      "decision-32c5111a",
      "gotcha-8a800920",
      "gotcha-777597e9"
     ],
     "plans": [],
     "pass": false,
     "graded": 0
    },
    "rp-43": {
     "spores": [
      "decision-a7d1bf51",
      "pattern-55f78337",
      "decision-16748312",
      "decision-48a78b54",
      "pattern-95c3e7c3"
     ],
     "plans": [
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ],
     "pass": true,
     "graded": 0.8333
    },
    "rp-44": {
     "spores": [
      "trade_off-8d1a35ee",
      "trade_off-a0713aa2",
      "gotcha-104287ae",
      "decision-491969db",
      "bug_fix-9d4bcb06"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    },
    "rp-45": {
     "spores": [
      "gotcha-89a50d19",
      "decision-358cba44",
      "gotcha-3da46fc2",
      "pattern-e6b83287",
      "gotcha-348b2516",
      "decision-4e185ae3"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.1667
    },
    "rp-46": {
     "spores": [
      "pattern-5c2725ae",
      "gotcha-0ce73b33",
      "pattern-bca367e0",
      "gotcha-8a800920",
      "gotcha-6699d14a",
      "decision-099a9b1e"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-47": {
     "spores": [
      "decision-915db719",
      "pattern-4c6f6ae9",
      "pattern-bca367e0",
      "gotcha-ee798214",
      "architecture-3f7cbad0",
      "architecture-9b116da2"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.3333
    },
    "rp-48": {
     "spores": [
      "decision-3d502b35",
      "gotcha-ea8bc225",
      "decision-3235fecb",
      "decision-7750ee22",
      "decision-5ec5b3ba"
     ],
     "plans": [],
     "pass": false,
     "graded": 0.4
    }
   }
  }
 }
};
// end of recorded baseline
