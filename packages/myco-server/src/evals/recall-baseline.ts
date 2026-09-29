/**
 * The recall gold set baseline (#1154): what each front door served for every case, and the Recall quality it scores.
 *
 * Recorded, never edited: `MYCO_EVAL_RECORD=1 npm run test:parity` writes it, the parity eval holds every release to it,
 * and `tests/myco-server/recall-gold.test.ts` recomputes both headline figures from the record.
 */
export const recallQuality = 0.1903;
export const caseCount = 48;

export const recallBaseline = {
 "version": 1,
 "caseCount": 48,
 "recallQuality": 0.1903,
 "targets": {
  "hosted": {
   "recallQuality": 0.1903,
   "passed": 0,
   "cases": {
    "rp-01": {
     "spores": [
      "decision-3235fecb",
      "pattern-951fc175"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "ca757980-619d-5bb0-973a-460f4112eda7"
     ]
    },
    "rp-02": {
     "spores": [
      "pattern-951fc175"
     ],
     "plans": [
      "ca757980-619d-5bb0-973a-460f4112eda7",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
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
     "plans": []
    },
    "rp-04": {
     "spores": [
      "gotcha-ab095250",
      "decision-941cfb9a",
      "decision-efda0a7f",
      "gotcha-77e66874",
      "pattern-f9df6f2b",
      "decision-2d352d4a"
     ],
     "plans": []
    },
    "rp-05": {
     "spores": [
      "decision-9cc38702",
      "decision-1af798e2",
      "wisdom-0ae9c566",
      "decision-99ff3f2a",
      "gotcha-4e22ff90"
     ],
     "plans": []
    },
    "rp-06": {
     "spores": [
      "gotcha-348b2516",
      "gotcha-0c86e21a",
      "bug_fix-baa434d4",
      "bug_fix-c1537c4d",
      "architecture-d57cea09"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
    },
    "rp-07": {
     "spores": [
      "decision-2246739a"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ]
    },
    "rp-08": {
     "spores": [
      "gotcha-05b29309",
      "gotcha-511712b9",
      "trade_off-a0713aa2",
      "trade_off-8d1a35ee",
      "bug_fix-43b24e4d"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
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
     "plans": []
    },
    "rp-10": {
     "spores": [
      "gotcha-0b64daeb",
      "gotcha-6668d672",
      "gotcha-05b29309",
      "gotcha-7f12b7a8",
      "gotcha-077d59de",
      "gotcha-993a341d"
     ],
     "plans": []
    },
    "rp-11": {
     "spores": [
      "gotcha-7f12b7a8",
      "gotcha-05b29309",
      "decision-99ff3f2a",
      "gotcha-582cfdc6"
     ],
     "plans": [
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
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
     "plans": []
    },
    "rp-13": {
     "spores": [
      "gotcha-0c86e21a",
      "gotcha-e5bf1d75",
      "gotcha-777597e9",
      "gotcha-9e60325f"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
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
     "plans": []
    },
    "rp-15": {
     "spores": [
      "gotcha-7df77408",
      "discovery-86f54e2e",
      "trade_off-8d1a35ee",
      "gotcha-a860dd00",
      "trade_off-a0713aa2"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
    },
    "rp-16": {
     "spores": [
      "pattern-1b1b5bdd"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1"
     ]
    },
    "rp-17": {
     "spores": [
      "decision-2d352d4a"
     ],
     "plans": [
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "a3b1e332-96a2-56e0-9afa-01876916c3a3",
      "39bada96-2647-57b1-9b87-9396a597ec1f"
     ]
    },
    "rp-18": {
     "spores": [
      "decision-2d352d4a",
      "gotcha-47345f8f",
      "bug_fix-274c91ec",
      "pattern-bca367e0",
      "gotcha-8c0e5692"
     ],
     "plans": [
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ]
    },
    "rp-19": {
     "spores": [
      "discovery-86f54e2e",
      "pattern-7f45f303",
      "decision-b998c2d8",
      "gotcha-b89e5f5a",
      "gotcha-4c67faaa"
     ],
     "plans": []
    },
    "rp-20": {
     "spores": [],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d"
     ]
    },
    "rp-21": {
     "spores": [
      "gotcha-00fffb04",
      "decision-941cfb9a",
      "pattern-951fc175",
      "discovery-6c072e31"
     ],
     "plans": [
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd",
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
    },
    "rp-22": {
     "spores": [
      "gotcha-ea1915d6",
      "architecture-dbdb80a8",
      "gotcha-a860dd00",
      "trade_off-8d1a35ee",
      "trade_off-eb979ed9",
      "architecture-11db18c6"
     ],
     "plans": []
    },
    "rp-23": {
     "spores": [
      "decision-b998c2d8",
      "gotcha-b89e5f5a",
      "gotcha-6f593485",
      "wisdom-b4f88d04"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d"
     ]
    },
    "rp-24": {
     "spores": [
      "pattern-4c6f6ae9",
      "gotcha-b6ac3ff4",
      "gotcha-9e60325f",
      "gotcha-36b3fda3",
      "decision-1af798e2",
      "gotcha-c3919ebd"
     ],
     "plans": []
    },
    "rp-25": {
     "spores": [
      "decision-941cfb9a",
      "gotcha-05b29309",
      "pattern-f9df6f2b",
      "decision-56ec66c9"
     ],
     "plans": [
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "39bada96-2647-57b1-9b87-9396a597ec1f"
     ]
    },
    "rp-26": {
     "spores": [],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ]
    },
    "rp-27": {
     "spores": [
      "pattern-b4690499",
      "gotcha-5aca3e37"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66"
     ]
    },
    "rp-28": {
     "spores": [
      "architecture-9b116da2",
      "gotcha-2db458a1",
      "gotcha-efaf7da0",
      "decision-16748312"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280"
     ]
    },
    "rp-29": {
     "spores": [],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280"
     ]
    },
    "rp-30": {
     "spores": [
      "decision-88ebab9d",
      "gotcha-bb66cfc3",
      "gotcha-9e60325f",
      "gotcha-a045ca07",
      "discovery-6c072e31",
      "gotcha-4c67faaa"
     ],
     "plans": []
    },
    "rp-31": {
     "spores": [
      "decision-c0b31bb6",
      "decision-30ad1abc",
      "decision-1d95cf73",
      "pattern-01feebae",
      "gotcha-0ac58ea7"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d"
     ]
    },
    "rp-32": {
     "spores": [
      "bug_fix-b7a0b15d",
      "gotcha-25b5948d",
      "gotcha-5c06ba4c",
      "decision-ccf7d50a"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
    },
    "rp-33": {
     "spores": [
      "decision-941cfb9a",
      "pattern-55f78337",
      "decision-30ad1abc"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d"
     ]
    },
    "rp-34": {
     "spores": [
      "pattern-95c3e7c3",
      "pattern-78fa6e80",
      "decision-c0b31bb6",
      "decision-48a78b54",
      "wisdom-0ae9c566",
      "architecture-0605a2b5"
     ],
     "plans": []
    },
    "rp-35": {
     "spores": [
      "decision-efda0a7f",
      "pattern-78fa6e80",
      "decision-48a78b54",
      "decision-bc755ab1",
      "architecture-a95609ec"
     ],
     "plans": []
    },
    "rp-36": {
     "spores": [
      "decision-30ad1abc"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd"
     ]
    },
    "rp-37": {
     "spores": [
      "architecture-78a3bf84",
      "gotcha-d5abdac1",
      "decision-1af798e2",
      "pattern-e751aa7c",
      "gotcha-36b3fda3"
     ],
     "plans": []
    },
    "rp-38": {
     "spores": [
      "decision-915db719"
     ],
     "plans": [
      "ca757980-619d-5bb0-973a-460f4112eda7",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd"
     ]
    },
    "rp-39": {
     "spores": [],
     "plans": [
      "ca757980-619d-5bb0-973a-460f4112eda7",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "a91df0a7-c4d7-5273-a7b6-2b068b4a96a6"
     ]
    },
    "rp-40": {
     "spores": [],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280"
     ]
    },
    "rp-41": {
     "spores": [
      "gotcha-ea1915d6",
      "gotcha-d5abdac1",
      "pattern-70522f4f",
      "gotcha-7f12b7a8",
      "gotcha-25b5948d",
      "gotcha-0fe1edb5"
     ],
     "plans": []
    },
    "rp-42": {
     "spores": [
      "gotcha-47345f8f",
      "decision-32c5111a",
      "gotcha-8a800920",
      "gotcha-777597e9"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66"
     ]
    },
    "rp-43": {
     "spores": [
      "pattern-55f78337",
      "decision-16748312",
      "decision-a7d1bf51",
      "decision-48a78b54",
      "pattern-95c3e7c3",
      "decision-01a1ec19"
     ],
     "plans": []
    },
    "rp-44": {
     "spores": [
      "trade_off-8d1a35ee",
      "trade_off-a0713aa2",
      "gotcha-104287ae",
      "decision-491969db",
      "bug_fix-9d4bcb06",
      "gotcha-348b2516"
     ],
     "plans": []
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
     "plans": []
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
     "plans": []
    },
    "rp-47": {
     "spores": [
      "decision-915db719",
      "gotcha-ee798214",
      "pattern-4c6f6ae9",
      "architecture-3f7cbad0",
      "pattern-bca367e0",
      "decision-e7a2c3a4"
     ],
     "plans": []
    },
    "rp-48": {
     "spores": [
      "decision-3d502b35",
      "gotcha-ea8bc225",
      "decision-3235fecb",
      "decision-7750ee22",
      "decision-358cba44",
      "gotcha-348b2516"
     ],
     "plans": []
    }
   }
  },
  "self-hosted": {
   "recallQuality": 0.1903,
   "passed": 0,
   "cases": {
    "rp-01": {
     "spores": [
      "decision-3235fecb",
      "pattern-951fc175"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "ca757980-619d-5bb0-973a-460f4112eda7"
     ]
    },
    "rp-02": {
     "spores": [
      "pattern-951fc175"
     ],
     "plans": [
      "ca757980-619d-5bb0-973a-460f4112eda7",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
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
     "plans": []
    },
    "rp-04": {
     "spores": [
      "gotcha-ab095250",
      "decision-941cfb9a",
      "decision-efda0a7f",
      "gotcha-77e66874",
      "pattern-f9df6f2b",
      "decision-2d352d4a"
     ],
     "plans": []
    },
    "rp-05": {
     "spores": [
      "decision-9cc38702",
      "decision-1af798e2",
      "wisdom-0ae9c566",
      "decision-99ff3f2a",
      "gotcha-4e22ff90"
     ],
     "plans": []
    },
    "rp-06": {
     "spores": [
      "gotcha-348b2516",
      "gotcha-0c86e21a",
      "bug_fix-baa434d4",
      "bug_fix-c1537c4d",
      "architecture-d57cea09"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
    },
    "rp-07": {
     "spores": [
      "decision-2246739a"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ]
    },
    "rp-08": {
     "spores": [
      "gotcha-05b29309",
      "gotcha-511712b9",
      "trade_off-a0713aa2",
      "trade_off-8d1a35ee",
      "bug_fix-43b24e4d"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
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
     "plans": []
    },
    "rp-10": {
     "spores": [
      "gotcha-0b64daeb",
      "gotcha-6668d672",
      "gotcha-05b29309",
      "gotcha-7f12b7a8",
      "gotcha-077d59de",
      "gotcha-993a341d"
     ],
     "plans": []
    },
    "rp-11": {
     "spores": [
      "gotcha-7f12b7a8",
      "gotcha-05b29309",
      "decision-99ff3f2a",
      "gotcha-582cfdc6"
     ],
     "plans": [
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
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
     "plans": []
    },
    "rp-13": {
     "spores": [
      "gotcha-0c86e21a",
      "gotcha-e5bf1d75",
      "gotcha-777597e9",
      "gotcha-9e60325f"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
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
     "plans": []
    },
    "rp-15": {
     "spores": [
      "gotcha-7df77408",
      "discovery-86f54e2e",
      "trade_off-8d1a35ee",
      "gotcha-a860dd00",
      "trade_off-a0713aa2"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
    },
    "rp-16": {
     "spores": [
      "pattern-1b1b5bdd"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1"
     ]
    },
    "rp-17": {
     "spores": [
      "decision-2d352d4a"
     ],
     "plans": [
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "a3b1e332-96a2-56e0-9afa-01876916c3a3",
      "39bada96-2647-57b1-9b87-9396a597ec1f"
     ]
    },
    "rp-18": {
     "spores": [
      "decision-2d352d4a",
      "gotcha-47345f8f",
      "bug_fix-274c91ec",
      "pattern-bca367e0",
      "gotcha-8c0e5692"
     ],
     "plans": [
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ]
    },
    "rp-19": {
     "spores": [
      "discovery-86f54e2e",
      "pattern-7f45f303",
      "decision-b998c2d8",
      "gotcha-b89e5f5a",
      "gotcha-4c67faaa"
     ],
     "plans": []
    },
    "rp-20": {
     "spores": [],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d"
     ]
    },
    "rp-21": {
     "spores": [
      "gotcha-00fffb04",
      "decision-941cfb9a",
      "pattern-951fc175",
      "discovery-6c072e31"
     ],
     "plans": [
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd",
      "d2c222be-93dd-5c33-8140-6792f695d4b2"
     ]
    },
    "rp-22": {
     "spores": [
      "gotcha-ea1915d6",
      "architecture-dbdb80a8",
      "gotcha-a860dd00",
      "trade_off-8d1a35ee",
      "trade_off-eb979ed9",
      "architecture-11db18c6"
     ],
     "plans": []
    },
    "rp-23": {
     "spores": [
      "decision-b998c2d8",
      "gotcha-b89e5f5a",
      "gotcha-6f593485",
      "wisdom-b4f88d04"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d"
     ]
    },
    "rp-24": {
     "spores": [
      "pattern-4c6f6ae9",
      "gotcha-b6ac3ff4",
      "gotcha-9e60325f",
      "gotcha-36b3fda3",
      "decision-1af798e2",
      "gotcha-c3919ebd"
     ],
     "plans": []
    },
    "rp-25": {
     "spores": [
      "decision-941cfb9a",
      "gotcha-05b29309",
      "pattern-f9df6f2b",
      "decision-56ec66c9"
     ],
     "plans": [
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "39bada96-2647-57b1-9b87-9396a597ec1f"
     ]
    },
    "rp-26": {
     "spores": [],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "a3b1e332-96a2-56e0-9afa-01876916c3a3"
     ]
    },
    "rp-27": {
     "spores": [
      "pattern-b4690499",
      "gotcha-5aca3e37"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66"
     ]
    },
    "rp-28": {
     "spores": [
      "architecture-9b116da2",
      "gotcha-2db458a1",
      "gotcha-efaf7da0",
      "decision-16748312"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280"
     ]
    },
    "rp-29": {
     "spores": [],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280"
     ]
    },
    "rp-30": {
     "spores": [
      "decision-88ebab9d",
      "gotcha-bb66cfc3",
      "gotcha-9e60325f",
      "gotcha-a045ca07",
      "discovery-6c072e31",
      "gotcha-4c67faaa"
     ],
     "plans": []
    },
    "rp-31": {
     "spores": [
      "decision-c0b31bb6",
      "decision-30ad1abc",
      "decision-1d95cf73",
      "pattern-01feebae",
      "gotcha-0ac58ea7"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d"
     ]
    },
    "rp-32": {
     "spores": [
      "bug_fix-b7a0b15d",
      "gotcha-25b5948d",
      "gotcha-5c06ba4c",
      "decision-ccf7d50a"
     ],
     "plans": [
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "36b535d5-0ea3-5aba-b1ca-161c276727de"
     ]
    },
    "rp-33": {
     "spores": [
      "decision-941cfb9a",
      "pattern-55f78337",
      "decision-30ad1abc"
     ],
     "plans": [
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d"
     ]
    },
    "rp-34": {
     "spores": [
      "pattern-95c3e7c3",
      "pattern-78fa6e80",
      "decision-c0b31bb6",
      "decision-48a78b54",
      "wisdom-0ae9c566",
      "architecture-0605a2b5"
     ],
     "plans": []
    },
    "rp-35": {
     "spores": [
      "decision-efda0a7f",
      "pattern-78fa6e80",
      "decision-48a78b54",
      "decision-bc755ab1",
      "architecture-a95609ec"
     ],
     "plans": []
    },
    "rp-36": {
     "spores": [
      "decision-30ad1abc"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd"
     ]
    },
    "rp-37": {
     "spores": [
      "architecture-78a3bf84",
      "gotcha-d5abdac1",
      "decision-1af798e2",
      "pattern-e751aa7c",
      "gotcha-36b3fda3"
     ],
     "plans": []
    },
    "rp-38": {
     "spores": [
      "decision-915db719"
     ],
     "plans": [
      "ca757980-619d-5bb0-973a-460f4112eda7",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "990011c5-7c9f-5d5b-a862-adda9dc25fcd"
     ]
    },
    "rp-39": {
     "spores": [],
     "plans": [
      "ca757980-619d-5bb0-973a-460f4112eda7",
      "c3371e4a-446e-5c4f-a5e5-2ad3049a937d",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "a91df0a7-c4d7-5273-a7b6-2b068b4a96a6"
     ]
    },
    "rp-40": {
     "spores": [],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "c3a9a201-7915-5fb9-9fe4-d83eeac49e3d",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "39bada96-2647-57b1-9b87-9396a597ec1f",
      "be8dfe7c-4a4c-5ed7-8d78-21ab983f56e1",
      "ce5c0870-3df3-5d2e-a4e5-085ddca95280"
     ]
    },
    "rp-41": {
     "spores": [
      "gotcha-ea1915d6",
      "gotcha-d5abdac1",
      "pattern-70522f4f",
      "gotcha-7f12b7a8",
      "gotcha-25b5948d",
      "gotcha-0fe1edb5"
     ],
     "plans": []
    },
    "rp-42": {
     "spores": [
      "gotcha-47345f8f",
      "decision-32c5111a",
      "gotcha-8a800920",
      "gotcha-777597e9"
     ],
     "plans": [
      "d2c222be-93dd-5c33-8140-6792f695d4b2",
      "36b535d5-0ea3-5aba-b1ca-161c276727de",
      "6a353fdf-499a-5d8b-80d0-bcb387d46d66"
     ]
    },
    "rp-43": {
     "spores": [
      "pattern-55f78337",
      "decision-16748312",
      "decision-a7d1bf51",
      "decision-48a78b54",
      "pattern-95c3e7c3",
      "decision-01a1ec19"
     ],
     "plans": []
    },
    "rp-44": {
     "spores": [
      "trade_off-8d1a35ee",
      "trade_off-a0713aa2",
      "gotcha-104287ae",
      "decision-491969db",
      "bug_fix-9d4bcb06",
      "gotcha-348b2516"
     ],
     "plans": []
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
     "plans": []
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
     "plans": []
    },
    "rp-47": {
     "spores": [
      "decision-915db719",
      "gotcha-ee798214",
      "pattern-4c6f6ae9",
      "architecture-3f7cbad0",
      "pattern-bca367e0",
      "decision-e7a2c3a4"
     ],
     "plans": []
    },
    "rp-48": {
     "spores": [
      "decision-3d502b35",
      "gotcha-ea8bc225",
      "decision-3235fecb",
      "decision-7750ee22",
      "decision-358cba44",
      "gotcha-348b2516"
     ],
     "plans": []
    }
   }
  }
 }
};
// end of recorded baseline
