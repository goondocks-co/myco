import { RETIREMENT_SCHEMA_STEPS, RETIRED_CONTENT_TABLES, RETIRED_CONTENT_TRIGGERS } from '@myco-server-worker/db/schema-v117.js';
import { V110_LEGACY_TRIGGERS } from '@myco-server-worker/db/schema-v115.js';
import { describe, it, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrationFileName, readSchemaVersion, renderMigrationFile, renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { SCHEMA_STEPS, type SchemaStep } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { sqliteD1 } from './helpers/d1.js';
import { publishFixture, sqliteEnv } from './helpers/fixtures.js';
import { markPromptProcessed } from './helpers/extraction.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';

const MIGRATIONS = fileURLToPath(new URL('../../packages/myco-server/migrations/', import.meta.url));

/** sha256 of every migration file a deployed database's `d1_migrations` ledger already records. An applied file is frozen: the applier never re-runs it, so a schema change is a new step, never an edit of one of these. Shipping step n+1 adds one line here at delivery. */
const SHIPPED_MIGRATION_DIGESTS: Record<string, string> = {
  '0001_v1.sql': '999b696d37063feb2126cdd716f57e8a15c9a177c4204eae3101ff4926fdaa02',
  '0002_v2.sql': '9a8cee5f16d76d37f2997148525de27e9716b1997263a67f7f4fecc3499a3ea4',
  '0003_v3.sql': 'ff2773c613c61ecedcc9bbb236c739c43b1811ae89e1b89c7547a7ed9f7e741b',
  '0004_v4.sql': '62393274aa0dde97a25fdab7f412a4a534244874150dac6f4a9b9f1aa4a0a348',
  '0005_v5.sql': 'b8cbcbe9a647d492d99f767b9779335f9bd724bab1024ef7c11d0686528770fd',
  '0006_v6.sql': 'c8b0d10e18841d4c5e16b08a0fdeb58d6fd122c5e369e6d708a21aeba50a9c19',
  '0007_v7.sql': '23211b666c32d96c55538aa2ea45a8dcdd49fa90d84086d6f1f9b05bb0f37493',
  '0008_v8.sql': 'b48de3ea7d93f99e29b8b5fa73d8543c18f91d71db52cf441e1d3bc90edb22c5',
  '0009_v9.sql': 'a9151650dbab2135b24a195517cc88e32b66f29b18bd211fd8c7ba2781ecbf19',
  '0010_v10.sql': '725651462a2fab075ca3891dd049cc27c5235ff481fe12769763c25b5c8534b5',
  '0011_v11.sql': '7ad31c92d2fb4a73b334bb60293225fa39545938c9ce022e2f8988dc04c99e5b',
  '0012_v12.sql': '7b708740fa80bdee06eb2145711ee89312054d4ca4f28da3828fb7ec8900add9',
  '0013_v13.sql': 'a152088648a3058772a7696d3bb5b9358ec3fb41d68554aab40ef7cb8d802c71',
  '0014_v14.sql': 'a4baab3fa7476a0b7da47968396ec9f0a4f739c8250194b7dd8b8a4756e00513',
  '0015_v15.sql': '56b8085ba9179e0aa93b63b383fb240935eabd1948a39a02fd5df12768d74908',
  '0016_v16.sql': '56d0f29d79664655e0ceb671dc4d5e66930dfbd2af0565c1f076ee81d8ef3a0f',
  '0017_v17.sql': '5f615c450cbfc1e0f413e13f95332d79a76a5e399558c5f7eac079f1c8d7cf47',
  '0018_v18.sql': '67440408a984d7b805395a5ae152694975d2e5ed5b6a6bd5b0b94b0980fb6b52',
  '0019_v19.sql': '7e1dbd6996831979c8141d239e29087489531ec801b7e91fc93fde79d153e8d2',
  '0020_v20.sql': 'ca39a216f15ca7e06f57cd4657a20397521fd24c196e06ef7a7d6d947d30133c',
  '0021_v21.sql': '0f5a1b7ee7d9173270c97b954d9a978685ecc294269b6195e31dcd9bdb526c21',
  '0022_v22.sql': 'eea54343253ecc08dea82df9976bfa0aa7c9af7a7ac0239c9cff72263862313b',
  '0023_v23.sql': 'f9bde4ce357f86fc912fb4c2f6be3f08c88eed5df1de080cc130a6cf65abe9d3',
  '0024_v24.sql': 'f6cc2bd6c8c8acda977565b7b01a666842a78deedf452859bc1935b0b35be9fa',
  '0025_v25.sql': '130505475de378ec88140ca998a60a197a891a1772927b3a5ade1dc449a77e78',
  '0026_v26.sql': 'aa6245f705061b2a4ecb006e464dbd0356e8f99fa0a91ea56a7f8aeb2423ba10',  '0027_v27.sql': '34fff0ea1db7f5a27507cbe52ca214c5f0990889971760cac4fc0c9ba1be7ca0',
  '0028_v28.sql': 'd6d08116335be071d2c210311931954109907594650588863bf05a4309877336',  '0029_v29.sql': 'c0ae2712efb51f36fe46ae65e8fc4b6e0429a7cd858822b3304d2278e31683d5',  '0030_v30.sql': '2f4e045992f7b1ab1ba214d90650abb1ef88a6593ffa97252f34cc826fb8142e',  '0031_v31.sql': '341942d604a2826d39f01338c25f2077190357e6b2ecdad87ce49c3c951d0d19',  '0032_v32.sql': 'd7a11dd14977af3b2087e5241cb7e619e2bcf08900e23b76ef14016c36cc3e66',  '0033_v33.sql': '761f86e4c25ebe6e121c08b5fe91c085dfce5b3712adede4a85f74490f0f10e3',  '0034_v34.sql': '81799fcf00e093a022b2c1bc078e786dc81385f576a706f655d46fbe14db849e',
  '0035_v35.sql': '45ceeaff4e2b2552b9243a7d170480648004a6c8b072a4358cf8fa13d49e82c0',
  '0036_v36.sql': 'eba2941c680606b353b387589e35de6936d70b90f3a8e1b87b99f0855c3990a8',
  '0037_v37.sql': 'd88255fecb0df779e0eaacf292dc50e6060673f75fea06b2a043abed7f57fd31',
  '0038_v38.sql': 'cbb499582b68389aa9488edb54920ebc09f68d129a1b03e1448947485f124b06',
  '0039_v39.sql': '8b1636924f5b298585f322bdd45532ce92b28b5b0e910ec1f9224be7527f8301',
  '0040_v40.sql': '0071ef8a116a057d8330378faad7b55a902ccf60e4d91aee06d9b7331f641022',
  '0041_v41.sql': 'b66e750cead64ba4385ff685929f80a3d688478c21c0c48c5c72598d11224efb',
  '0042_v42.sql': '7c83e400c78aef7599ed3eaac0bf9fe4a8151dc3fe135b994ace8968410e0f54',
  '0043_v43.sql': '8de14652822ee05f083d6624c7552f2250fb30f3d7b69da15f6cbb030ee59a8b',
  '0044_v44.sql': '164ec19a7767620d6311bb926816bb0d35b12974033faff88ae24db490c9fbc3',
  '0045_v45.sql': 'cba9c6bca05a12ed0645dd876faa41a1404776e60ba8efb8e485fe70311b73bf',
  '0046_v46.sql': '55cb94a2563cedc00a3b52aebac592f288377ff7a1ccbf5af7766f8c970b8003',
  '0047_v47.sql': '51a1ec0db9be9733a45c1c2f71a290866f0ff6b722e94ca135bcb234c29ceafb',
  '0048_v48.sql': '97225cac29e20c2174dd76c296575f0e1e844e7f40ff86f938e39bbb5f83a1fd',
  '0049_v49.sql': '860a63d6bd62e906e4cee88dc8cae21b4a283d5db376cbe815faa18dd9bd75f7',
  '0050_v50.sql': '5d334354e3ae48f22c66d6734b3da79a0a184ae575d857c7eb8c649db5fb0027',
  '0051_v51.sql': '0887247ddf39a1e803f4ce57441f4d40b99127368316e5b64e8cc38e56fd87bb',
  '0052_v52.sql': '8da3b5d53c14ec255793fc35df9c62a9e7edb2a31be5db85dacf75b41a836732',
  '0053_v53.sql': '80cab6b7c85eb0a4a6d6c50d2e3395c4d96ce784f485fb064f8dd448dbe2f168',
  '0054_v54.sql': '9c3b07ed9c3748766d943b0505b55a46d97645048b9070aab52ee25c3e8f6c01',
  '0055_v55.sql': '8cab92da458ed8d87d8df4a5b4ece25ede6adbebcaab554acc7be1d93ba21588',
  '0056_v56.sql': '8bfa628b3dd8a83dc4a9653d5e5c075a2daaca036e7a2911076db75bf8655266',
  '0057_v57.sql': 'e9f94d27c17bdff1a62177365935dd4337a3ee473b55d39ede9d0fe1d9213b06',
  '0058_v58.sql': 'ddc9ba2e777165d49db3840a8c7e1811a7d329d9c826713398e5c21e05c9a401',
  '0059_v59.sql': '460d680d4d62ac6facc473f38f87c9438c1cd6b42ae4a285801448e200c9581f',
  '0060_v60.sql': 'b118ff2d8cc43ad5e1cf5bb38ca4bb4ced065e334c48a53e7064961583caa2ef',
  '0061_v61.sql': '840277e73ce900814ed9cf1764f502586b8058c2f8fc3552a189cb6a9832b26b',
  '0062_v62.sql': 'e993cf1ec1a9cd1b1ad827f154b08cc7a82602daea80e752414e9c769e7afdab',
  '0063_v63.sql': 'fb950a25459f47537b9f02df3450855f6a57c1a94a7d2e235d6e3b15afff8510',
  '0064_v64.sql': '013cd169a7a602907ba968c7d85eb3afa2d373ad62f3150e75cbd4acfd1436a6',
  '0065_v65.sql': 'e751de4749769975e59fbd2d61e2aa606eb4c7b463eed6f5487a1460e810e442',
  '0066_v66.sql': 'd0fcc415477707308b601c570adbcec5f0f45831545888e553aeb9937cc65aaf',
  '0067_v67.sql': 'fd1348570100dce0ccb4d580b8880764c1b5118868ad23b1fdfe0ab88b2284f4',
  '0068_v68.sql': '0140d5ef41ef8f07301a3e1fdf0c34414b3070b5c264c01c97a9da18ec85e178',
  '0069_v69.sql': '37ad86138c143f8b83e4420127ecfcc90207234e1812551cd867bb50c06d526c',
  '0070_v70.sql': '167c3f343185d9270b55240cf0c08736f140e73a8c2b948d5f6c99f08e26a5bf',
  '0071_v71.sql': 'cee502e6a5b14d599659d9f45ea050150a1463a428a201b607aded7ba121d85b',
  '0072_v72.sql': '600f5b7fb92fcb242917187cbc8a3f1ab0854457955c60a480800817d6ab44af',
  '0073_v73.sql': '1166cbe8d2c61ebb7036377fad5cf430a3fe81a5bc47103a68242920c83a6ae1',
  '0074_v74.sql': '577eabed8b5fada9ef0b34476966956a3be9800e36deb3eb6b4b4db7277333c1',
  '0075_v75.sql': '02da28917e27738af41acef31c5aa0b29af26e99cda1a8833d9b24f58fcb93b5',
  '0076_v76.sql': 'd7616df59876096cc02c7a7bf1f80ee8b0305382d5df41e37937ba35d329850e',
  '0077_v77.sql': 'b8b77ef73a44befa8f6eaa9b435a4143ec2bcc530142cdc43e5f9f9ca416f7bf',
  '0078_v78.sql': '9d5cf706bdb1f5035b72d594269af05794cce472621b8cc89e4fe74968b634ec',
  '0079_v79.sql': '02f2c627ec1c3ad0c75919c36d0d6aa8e4e496a00c34fa7fab16b38700ad7a93',
  '0080_v80.sql': 'fb7d05d507a30f397edf9ba30446a03dab05193b9c455200253c5b7c55892c21',
  '0081_v81.sql': 'ff4cca162f9535c6d986119aa2ea46a5bc72c227d650892c041739d321691678',
  '0082_v82.sql': 'ecd8204b533c31ad7a1d8bf9961541194407e9a3c015f6b6d418f9ea934a4cd4',
  '0083_v83.sql': '50efde38ad19781214aa8b025343660bfc00e39de4aa11994604571ad30d70d0',
  '0084_v84.sql': '92c26cabc06b55c58df38111d8ac4f325763105221aa8ae8a455987cc35b2e5a',
  '0085_v85.sql': 'c534f3ed2471b58db2cfd6cb60e4d624f2e2db052a9d424341f923d64a67e403',
  '0086_v86.sql': 'adb34a77e0dbb775b05406a6472572d0ce6e3559cd5a0dbf7fab26adf6a6919b',
  '0087_v87.sql': 'b6d34853a1bfb8fd1ee45da16f1405cc806b0549f1753443956e27964d892cf6',
  '0088_v88.sql': '7b40d6a4ffee4576a0000e12255891bc03bb06bb324ac5fcedb606ab042c3a08',
  '0089_v89.sql': 'a2e8b73fdd1b05be584e33dad00ea7b4bce99956723f5ecbb3bbced2aaaed725',
  '0090_v90.sql': '3283a9899503b34a9ef1128212165eb5fe0b162ed8841b958f333024166f30cc',
  '0091_v91.sql': '720193aa84978a9f2b8b54f6c33e3ee108f9a58607026aee5c589d45c8932035',
  '0092_v92.sql': 'a105b641c089ef95cb34859fe6677c8db5caf26945ff09dd215dcd0ebdebd82b',
  '0093_v93.sql': '1cca9fc6a4f8b23eb5ddfa1dcba5a03cd215700fbcc929ff8658974657435387',
  '0094_v94.sql': 'c4a1cc5e3952460f3981b0487321003566b88335c52c6148d95b4ca4cff1b72a',
  '0095_v95.sql': 'e6e20556516e5723e3a4bdc09a62fe704b448bdc076204b78b544c8a07e688bd',
  '0096_v96.sql': '4d8a3764c9fc51c77045880adb7e621868f035137b4ac983ae96d6e69ae13af5',
  '0097_v97.sql': 'aeedee8552c8108153fd5a578b1bd287104a7f6355da55b0fdf6282a7dde960f',
  '0098_v98.sql': '64e6ef29947424c0ab00b607773596989a42cc6ad78da1334e172dc8b526eace',
  '0099_v99.sql': 'e0cb58c903bc05ce29293b2babe6c02df7419ffb42c97c966654c8f38fb6b6a9',
  '0100_v100.sql': 'ac5a2268d4091da1a071e1f752bbbb11bb13e996a0f5156ce041db65fc91cc18',
  '0101_v101.sql': 'c7020bea1f6f4d910ca2d1285350ea165d6dcdad094b0c724871a347fb7d118d',
  '0102_v102.sql': '2e03935f359586bef3a17f30032e8194b29a13a8aeb4976d884daf12980d7546',
  '0103_v103.sql': 'd33137646ce13bab7b132c078be37c178c016798795091ee94cfb94110169cb7',
  '0104_v104.sql': '2a923b33713136857957ef044810ee748c1bf7d53df0a0c89e0a70444a0eeafa',
  '0105_v105.sql': '267535594f2664a73451111fbc6d0ae454bab578ae54dac578cbd2b32523d217',
  '0106_v106.sql': '6a1ae57733a69cea25cfb2c212648502b88b80759273df922f97d2c1b7866740',
  '0107_v107.sql': 'baf72d227e20a9f4632af5b50c76323cd30ff8e7c4b2a10d064b04df9e503a89',
  '0108_v108.sql': '3e765561e232a9080f8399896669626909343e6e298268b59659dc9e0447ff1f',
  '0109_v109.sql': '5205f6e214876498cdf2423be30831ff9c9984894ea32967d09c762f5993e539',
  '0110_v110.sql': '6c7f344d5df92707160fb473b8973e28f17bdaeaa049e64e04c8609192872a14',
  '0111_v111.sql': '764e3320141f27826bd38716febe028a83a8c898be8aaa50bddac37af17a057b',
  '0112_v112.sql': '86092b5ee45c43ca54ae8ec15f0c1ea08799d25cc187f98aa9afc2c57e1d8ac1',
  '0113_v113.sql': '389e1a4b4c92de6df94e7a4f66e7e2c14e769fcb9d9937721ab2ffd77baaed12',
  '0114_v114.sql': '98f3e9945585c1cf8dacf510a2fc516308786ab541f045f5fc225134bba72c6c',
  '0115_v115.sql': '2294b761a948cb8d15ab9552c36ce9373037480e389bf1e3a0f402e0814d62a2',
  '0116_v116.sql': 'aa4873f1546a150d5349fae34fed7ff63daafed93a83762db2b5729985ab0bea',
  '0117_v117.sql': '7f80b23f585d4263317b13a2694ac6677303fbfc8cb04be18effb649d6c37799',
  '0118_v118.sql': 'b4a974a787dd5e727d33e6ef83c6b633c46ed4896d58245d71031c7802975f46',
  '0119_v119.sql': '4e202e151717581e2d2d12d883ad4326a1088d4c1bf491c896ff48bb595c338e',
  '0120_v120.sql': 'ecb8af6b333f2f4ce5ded2b0e1f1907580ea943f26c0cdcbc783b4ddd0c7534b',
  '0121_v121.sql': '326c509a393e505d00f30264d38757f7e8b4e48dd3d51bb5c09024a7cbeffa45',
  '0122_v122.sql': '9b9f4479194ab3aad8dccf962a4e6a313be1c4cd0313ec7b56d027d228859abe',
  '0123_v123.sql': 'b16d25c1c330d1fc510a6b6757048b214e9bf9a29c2312c841eab8a064dce85a',
  '0124_v124.sql': '3c12683d83a99acc3e05859e614b0796b9eaec27b6faf2b7b6b67ae867d5e839',
  '0125_v125.sql': '03b772fd571a989ed49ab665d78c6bdb97417b20c139821c979076b883dba770',
  '0126_v126.sql': '901aa8fd3c957a56e9cac7e0b401f3892bd2d54de9cc475d76da0acda3ea2ee2',
  '0127_v127.sql': '9860f42aaaaf1018b0d915b0ceb547bc3e70eadb55b6f7b4699aff4084cabf39',
  '0128_v128.sql': '1dd14683fbbe5c16332534ebefa1b0d3a75c480db7b419ab2cd4e6341363fbf8',
  '0129_v129.sql': 'ebe599b5a0e64996a6930aa0f2c3cfd5f38852e3b5e2b0c0774c620fbc717f17',
  '0130_v130.sql': '08be413268ae7a9a8f6e68724eb3801412be959d2e7ff5cb360b6f50430fbdc4',
  '0131_v131.sql': '0aea8ce82e60e258a7040d388bd55892240ce7f35db8d6c1ddc5f4cf41361485',
  '0132_v132.sql': '95fc1f9ff6d12b38c991fd9db4f143151a93fb367b004f713ce65ee9a479c63f',
  '0133_v133.sql': 'ae21c455be6c6d8a42f6dcf3b2c349f7ef343454a65537baf3e49553027544be',
  '0134_v134.sql': '150d7cdd88b32dec40124133800a6759ec11578db2fa4441f5a335fa484041e0',
  '0135_v135.sql': '4230b9f21ca62a0c529d42d21a16d185cb0a166ef41846744eb41d06b70375b2',
  '0136_v136.sql': 'c9aa382a5bd4725e646a0e1e6546f1f549004193d493ff4c9eea974fd009821e',
  '0137_v137.sql': '7154feb5503d31201eb19d1431fe01b1028d56a03eb0910303c454b70144b41b',
  '0138_v138.sql': '396ef583313e4653847fb25b60e1d7f03c7104c5d1f3614b70ec2822dd9a4d21',
  '0139_v139.sql': 'd616edf187e1216328fcde5a97e596024f2f99d9d0d8ce860b4a810062448ee2',
  '0140_v140.sql': 'ec1843a5e5e77b450c75b8377b3ee5de63867b72e237b0681e40d0548c384927',
  '0141_v141.sql': '93ad9b6bf22215ce7c1a125ad0c84e030cd3bd4fa4cf0d6c026e1b95d740bbbb',
  '0142_v142.sql': '1ac56c2f3b1d2dd093dd3a65a8254b972543c13c53d0c1579649e53c1221fe01',
  '0143_v143.sql': 'de8fdcb40f00073d989b094b8266a88c115c57950d3eb6ebc2da456442f78d69',
  '0144_v144.sql': '5df779f9708ae29f51ed0aa9c18797c64176d7f3f13f3699ccf199453108fb41',
  '0145_v145.sql': '223e3ea26b65c626317af6ce704929fc904cabb6ccb7979e5da1f980d99dd2b4',
  '0146_v146.sql': 'ce876bb9c7562ef919eba95740d74edaf8080937daf7d935a1083e51bf38104f',
  '0147_v147.sql': '3ede91c34157da66103d0fe4958deb6a5f149a1f9d534b018998d18b56618c6e',
  '0148_v148.sql': 'c2fddaf2aa0d793d9899b4aae8205dc7891ebb3f75caca3ec3cce52900058d59',
  '0149_v149.sql': 'a4c024c1c2b7f9c3cae6336b444775ee1a30fca10a66dc314222216c7354dda6',
  '0150_v150.sql': '0a07c651a010e535003db916ef3718cbe3b5b4d6ddd6f2f57b2a8199718bdffc',
  '0151_v151.sql': 'b00aab57d266576899989b2a3e87791608caca3a965b36214be000c78f846c75',
  '0152_v152.sql': '4f7c7ca4ce34229e7741d2b2faaf8111fb480ae901423355ff3cd95055a25787',
  '0153_v153.sql': '770bf2d8ca8ee78023a55721d92fc87fe7bcccfa184c145e9c790f082569f4e0',
  '0154_v154.sql': '91923e89809609dbff755af9b4e81374327d3301a73b8e362bf8fa2ca4aefc36',
  '0155_v155.sql': '042825f58dfbaa89e7abd7e336ecc071f9015d5b4406dfb46ba472dae97c2582',
  '0156_v156.sql': '296b8bf0cfc1e1136cce0705d0d7f35ddc90f1b47acf3d1d53a7769cbcb75c57',
  '0157_v157.sql': '5c112f748217ffd09421c92edda87f4c295d5c6c5002e889115c857274c728e8',
  '0158_v158.sql': '9984b6b94f0c4b4f02dbcfcaa7c17416832cfc6eb9c66d3e2cd8165706d6ad53',
  '0159_v159.sql': 'def7101010786be62b9a891cc177db24286a6dcca550e33b841c365747492e29',
  '0160_v160.sql': '411becaf4d1844bd7eaac16465d24ca21fe00057ece61e32def82e3862fc3e05',
  '0161_v161.sql': '8b8b8095cf6e3e74106670aa351c92d94e01dfa279b0652de47f643e7e8eae8b',
  '0162_v162.sql': 'c3e0826f9e57ca5330270381101b74761af323e785c7892d99742c21866a1145',
  '0163_v163.sql': '5adab192e80a5da80f1a162c50d6fe1cfc975d20ef6e596ef0621855fb0130cf',
  '0164_v164.sql': '8a3105cb261617bda9cbd16e602ea72596c24077c0a5c55306a33f0ba369a6c3',
  '0165_v165.sql': 'fa6069ece5d238b0cafbd3f299fdd01051c0e5417b22132feebe71d6ac041934',
  '0166_v166.sql': '53b8d79b4136b80fe886046056cfa5f97d26b1a4738c5eaea9ae26044a2271ba',
  '0167_v167.sql': 'e372e0259f1e077b1d8ffd4499c0e289eb945667a2c9c55472eaf513221e11f3',
  '0168_v168.sql': 'f891d15394eed2002fa1ac290e1bd43550e04be680b22aed5fff00ec744a7e4b',
  '0169_v169.sql': 'e5a6fffcc53f94a67a066fb06c22ea5955313f85074a4f3078be6a740915b1bc',
  '0170_v170.sql': '71b5a331d874a8b2ee0acdaea4848029de34cba09c98217765ef5bde1715a9ec',
  '0171_v171.sql': '496377b46781059df1e297e4d292c940af60f48290bb555dfd1c762377852019',
  '0172_v172.sql': 'c0c7e91cba23b978ea3155eb4ee414fa82f55ab94b77e3714b026eed9f23feee',
  '0173_v173.sql': '10acd6f16c3192112cda7aca9e9979d58f56c80e8d8ca2ca84e1b9b8df5a8ede',
  '0174_v174.sql': 'b9a42d2bfd83cd0e4ef8cfe54280580cd3869fe6e1e29da6840f6b500396d55f',
  '0175_v175.sql': '602d01b2a157bac78edb921464fd4b9ea20c595243a6686e3ce0e889ebaf5037',
  '0176_v176.sql': 'aaeaf2032762099c9d0b52ccf7ba7da810fdbbaea91073d7901c7284d3a7d6b5',
  '0177_v177.sql': '8f7e7c7ae18e7caa6ac8828599098d55c573d530d650e03af9fc05b14ea8e10b',
  '0178_v178.sql': '3d5997a3797c2aed55d4802a50d072e47c952617b2e8db9a2107034b4fe23ee3',
  '0179_v179.sql': 'd8021a6251feef56c0d6685a3fe992fc4b801d875b7f6bbb72392f83f905344e',
  '0180_v180.sql': 'e3d540b5b6e08709d10d2d37ecf435cd304fa93d094a21996d1d46f96489bc35',
  '0181_v181.sql': '263a76d020cedb5b6bd3676cc25e0d4cdb7a9d5ab4376e20b215bbfac852c9ce',
  '0182_v182.sql': 'eebbde3ddab54713a2c07b4c2dde7bb116956e318367361b422bea8e523d66ff',
  '0183_v183.sql': 'b981631768dad2653f72417086461337ce33e371a75bf224dea13f75c6f46c70',
  '0184_v184.sql': '08f95c2962df964a25d910aa91c32bc15d877b201e9581c480a9f1050c313ec6',
  '0185_v185.sql': 'f61b005fa7d466873bf476ef943921aac3a0cbc1c728baaa88b7c45d7a5ce184',
  '0186_v186.sql': '1c9832af8de04567fb9fffe97734de4e9236467479d34605b961bcdb4c92b4d9',
  '0187_v187.sql': '6767ac46496800c3ab0ec7525cac26850b3ce74ac9cf0a63f7a9ea98b203b077',
  '0188_v188.sql': '8e5292fbe73200a1cbe134c3d6de02d66b8c28999e3cb252fe5b3308ad45817a',
  '0189_v189.sql': 'f7be8974af0c10d16e048290974690b1f275a8a2339555735130a9150e92974c',
  '0190_v190.sql': 'dae46a40fab6736423a5269488b182028ff604e942904bc4f9a2f4aec68b34be',
  '0191_v191.sql': '33fe61a190eb23b788c9b1f49366fb859663a4e2e032cc3fd7d5d7705196d591',
  '0192_v192.sql': '9ffc3edb6502f23b48a4d7fae6dc38bf9dbcfc71675737cda8d098b72ccfd1dd',
  '0193_v193.sql': 'efd4d19c556a8faf9565ff8fa04b043463c8fe923a7f1213411fde60a9e0ffa5',
  '0194_v194.sql': 'a3d0a1ec9e3790fb700232472d15b32b9990dbd48e8580e329e9b301cbe95741',
  '0195_v195.sql': 'dee8f51343dfda8892243bcf1b000b989500a1aa59a9d2e0316fa074b5eabc53',
  '0196_v196.sql': '0cd991feb7a8d7b23e72877dea3f7ddc3087a1e32d6da54dd408290c25a1fd93',
  '0197_v197.sql': 'c58e12970165fc4c4c7e6de50182096fb6222bc87bc03373c2cecf82dc2638df',
  '0198_v198.sql': 'c55e0a93a0660a76337b4089bb67e893aceb3c43760d2b8e79408c719cc715b3',
  '0199_v199.sql': '97d01b32d37a3a74afb7fe9eb8de9b06ada833a2e7ba80a126b5ab113d04e827',
  '0200_v200.sql': 'ff03b00b5816b0454dfbf0e6b1beb728f9330a2b5da98fc305e37c70c448fbf8',
  '0201_v201.sql': 'f4b9b40fa97f6f4d08473a80b06f72e46ec008b8e48eafd403013475ef86f4b1',
  '0202_v202.sql': '38d2a4406280395047592bec81ce4eef6b029b2266dc0d98d8adc9ae933630ca',
  '0203_v203.sql': '7fbf1268b6a18608da70cd3339729cfd4f5b61499ca6e7aa3a9cdf4faa3ce79c',
  '0204_v204.sql': '6b600ad5e0ce7fbbc599d99f04524d42ce2d812428126dcdbb9472645daf0273',
  '0205_v205.sql': 'db7392f00fc57d0917f948c02a07bf861c2c565dd192c9ab13243ccd350ae51c',
  '0206_v206.sql': 'a165e9a80193b8c8ff297117fd7161419aebc6eb87ee73424abb8835f9e07625',
  '0207_v207.sql': '2f6ffdf281b3725f8482556ac25b3a2726deeb2cf8b007430da59bb234e37347',
  '0208_v208.sql': 'a78390a2f2e85af5a52af16a91016812f7aee117b4c41b6689a208babc199791',
  '0209_v209.sql': '5568d6290e0ae2baef7b183ccc55fee5177c0703950fe35462941d67ba11cce5',
  '0210_v210.sql': '215d6c5b7fba87ea6460ebbd37fefeb5b87c5d3d8a3a139ce83665b69d67d76c',
  '0211_v211.sql': 'ff48d6cd42a76178f3c1ccba7f88c912f2930cce25afcb7a273ccaba4e9e5b80',
  '0212_v212.sql': '45c05a76e8e3b17f67b67d7e6482941bce2242e0e37b96ec875f67c610991c2a',
  '0213_v213.sql': '5a5f3b66970bb4fe0ab5e9f77f9847b68a3cb6cf7a8f10d0a207125ad2cfaf71',
  '0214_v214.sql': 'e574b64e43e5e3276f284a168cfae92e0413abead1107970e44eef2d5b14514a',
  '0215_v215.sql': 'f7cc98a47f601bd30e31b5226228dfd85d11ee2b64290ce985754585e282203d',
  '0216_v216.sql': '9fb98d1de6aa15a391c15125b4493dd37338617d15e2ae4813940a6cd66a9486',
  '0217_v217.sql': 'dd831b5cf86f5f5e8b65bcac1b301614562f2b6aece07505ad1b2b8dca4b2308',
  '0218_v218.sql': '624eb67bbe6798914b411c5a9070434e638db6aebb75f957d31e1e231e89e978',
  '0219_v219.sql': 'b3f5df0646f873253b95284320f00a581ff32f666b1864c5bc1a8ed99c826075',
  '0220_v220.sql': '093dfcb54a6bbb4f9ffc0983f4768a9dc25cd3bbb335d40f4d8ca155a73158e4',
  '0221_v221.sql': '06bd71f61a17d679e7ffd50202ef8c7a1d97f50358127e864b2bde0440376fe4',
  '0222_v222.sql': '7ca68e7845460334302d0e4534168b38508a94141f98146664a6da47306dfeb8',
  '0223_v223.sql': '78b4c93f9560abf5acc44baacc21468785008286f9fa6dd589546fc44cde468b',
  '0224_v224.sql': '3ee137c62350024434ad2c9303ae384746754bd61966fdd25f33722e9ea36845',
  '0225_v225.sql': '306e27e8da70cf4930029c35216d8823dfdfd457426bc88c596470b035b30166',
  '0226_v226.sql': '103a0a4d7660908416902da0a4a0ca754b6ab62a68444e115f90b78b3846383d',
  '0227_v227.sql': '0395cf6115faf1c927c630ab7eefe6c7b8b672d2977cc29b9d82d6214251a9fb',
  '0228_v228.sql': 'c1abe3c4f99125d889a77735503794805e3907455e4bdd020bcf20bf88d06054',
  '0229_v229.sql': '6b73080e020528966e327f2ff1619466917876413bcc608baa96a4ebf69d8d00',
  '0230_v230.sql': 'd2f6bf54c0e3c65295cf03a0718f096c177019560f07d9f600d651d3cb53e6cf',
  '0231_v231.sql': '35584476b4158604f2ce5d15bd3450a55872392f185ba6c09c9a7597c977b665',
  '0232_v232.sql': '32451e94cc5cfce10db7892410e0c054cd83e72b13218cc538697e3b87317253',
  '0233_v233.sql': '19227697eaa3fcdb3630fa50eaa383f4093af81c815a236f5cfb110db1cda0c7',
  '0234_v234.sql': '91c5a80cd1b822aa62c52b851b2fc167a2b70f5bafae645e132990f7b3e982cf',
  '0235_v235.sql': '656593269d5448097c24b56136380b1f789ae722e709278e4cc0e177d5c16e3e',
  '0236_v236.sql': '0d4ce52598ba9e9347cb5207b19b8e7e3ce9b77213d7a5f0372e42360c9def8f',
  '0237_v237.sql': '90065f4862d7ade70d73beec2682d533fc065e04a4d5206ff4106c40f90873a6',
  '0238_v238.sql': 'd57e04f5fd7c7b4e63f02609640eb690a48bfb3eff0a7bb359ef44f050f51eca',
  '0239_v239.sql': '0c3467d6f2f7d86778ad09aab860e5c0667f85cb96e518d74ead4d05640a8454',
  '0240_v240.sql': 'b6caa11edc46075aae9f808c630f140bf2ff66de84d6c5b07a3748583adcfd0b',
  '0241_v241.sql': '61035ac990c475e4615dced2669eb2f7029a7589cb0586b776196827902cf53a',
  '0242_v242.sql': '2873eb3a63c7f2eeecebb32b28bdec8c3e424029a1323f5dc0aff108aaaf7701',
  '0243_v243.sql': 'be326298fbaeec1a1547311fef6fe60899d695e10ab08b199d96bdf43d4830e8',
  '0244_v244.sql': '8ad684f725122995add1d69e9b99964bd2b1f823a20b0e098533ecfb8f077e47',
  '0245_v245.sql': '9b190f66d66df3417e25887b03c3367de27436966537a5ac12978a4ea766fb4d',
  '0246_v246.sql': '11b22b285768e3572df841f8108e0d5244ca7b06a7bd023b0697f542426ae808',
  '0247_v247.sql': '2f74b7f73f0cb7b63c9dbe948f0e6b881f8c687c357c4f69a7edc49f19cccdac',
  '0248_v248.sql': '97cf17e98c02589a6cc4459ee1e8bf087da655e2fe8644963e72552f1bae4c78',
  '0249_v249.sql': 'bfce69196453148dd5392d265f032096004408e276dc21c1e64e82512d1aab08',
  '0250_v250.sql': '20a476aa5c0c8ca2b7a1334bd1e0e0e345ad5422a354b96981de7269508caec6',
};
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The schema of a database as `sqlite_master` rows, ordered; the version row is compared separately. */
const shape = (sqlite: Database) =>
  sqlite.query(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all();
const version = (sqlite: Database) => (sqlite.query(`SELECT value FROM schema_meta WHERE key='version'`).get() as any).value;
const schemaVersionsFrom = (first: number) => SCHEMA_STEPS.filter((step) => step.version >= first).map((step) => step.version);
const PRE_RETIREMENT_STEPS = SCHEMA_STEPS.filter(step => step.version < 117);
const preRetirementVersionsFrom = (first: number) => PRE_RETIREMENT_STEPS.filter(step => step.version >= first).map(step => step.version);
const fresh = () => { const s = new Database(':memory:'); s.exec('PRAGMA foreign_keys = ON'); return s; };

/** Inventories accept only a canonical ordered prefix of schema steps. */
function assertPrefix(steps: readonly SchemaStep[]): void {
  if (steps.some((step, index) => step !== SCHEMA_STEPS[index])) throw new Error('schema inventory requires a step prefix');
}

const columnInventories = new Map<number, Map<string, Map<string, string>>>();
function declaredColumns(steps: readonly SchemaStep[]): Map<string, Map<string, string>> {
  assertPrefix(steps);
  if (columnInventories.size === 0) {
    const sqlite = fresh();
    try {
      for (const step of SCHEMA_STEPS) {
        sqlite.exec(renderMigrationFile(step));
        const out = new Map<string, Map<string, string>>();
        for (const { name } of sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]) {
          const cols = new Map<string, string>();
          for (const c of sqlite.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[]) cols.set(c.name, c.type);
          out.set(name, cols);
        }
        columnInventories.set(step.version, out);
      }
    } finally {
      sqlite.close();
    }
  }
  return columnInventories.get(steps.at(-1)!.version)!;
}

/** Every index a prefix of the steps leaves standing, by the table it is on. An index a step drops must have been created by an earlier one, so a name absent here is a drop of nothing. */
const indexInventories = new Map<number, Map<string, string>>();
function declaredIndexes(steps: readonly SchemaStep[]): Map<string, string> {
  assertPrefix(steps);
  const cached = indexInventories.get(steps.length);
  if (cached !== undefined) return cached;
  const sqlite = fresh();
  try {
    for (const step of steps) sqlite.exec(renderMigrationFile(step));
    const rows = sqlite.query(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'`).all() as { name: string; tbl_name: string }[];
    const out = new Map(rows.map((r) => [r.name, r.tbl_name]));
    indexInventories.set(steps.length, out);
    return out;
  } finally {
    sqlite.close();
  }
}

/** Every trigger a prefix of the steps leaves standing, by name, with its SQL. */
function declaredTriggers(steps: readonly SchemaStep[]): Map<string, string> {
  assertPrefix(steps);
  const sqlite = fresh();
  for (const step of steps) sqlite.exec(renderMigrationFile(step));
  const rows = sqlite.query(`SELECT name, sql FROM sqlite_master WHERE type='trigger'`).all() as { name: string; sql: string }[];
  sqlite.close();
  return new Map(rows.map((r) => [r.name, r.sql]));
}

/** What a trigger does: when it fires, on which event of which table, and which tables its body writes. */
function triggerShape(sql: string): { timing: string; event: string; table: string; writes: string[] } | null {
  const head = /^CREATE TRIGGER (?:IF NOT EXISTS )?\w+\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)\b[\s\S]*?\bON\s+(\w+)/i.exec(sql.trim());
  const begin = sql.search(/\bBEGIN\b/i);
  if (head === null || begin < 0) return null;
  const writes = [...sql.slice(begin).matchAll(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|(?<!DO\s+)UPDATE|DELETE\s+FROM)\s+(\w+)/gi)]
    .map((m) => m[1].toLowerCase());
  return { timing: head[1].toUpperCase(), event: head[2].toUpperCase(), table: head[3], writes: [...new Set(writes)].sort() };
}

/**
 * Whether a view or trigger a step drops at `index` is created again later in
 * the same step: for a trigger, on the same table and event, writing the same
 * tables as the definition it replaces (`prior`).
 */
function recreatedAfterDrop(statements: readonly string[], index: number, kind: 'VIEW' | 'TRIGGER', name: string, prior: string | null): boolean {
  const create = new RegExp(`^\\s*CREATE ${kind} (?:IF NOT EXISTS )?${name}\\b`, 'i');
  const later = statements.slice(index + 1).filter((x) => create.test(x));
  if (later.length === 0) return false;
  if (kind === 'VIEW') return true;
  const before = prior === null ? null : triggerShape(prior);
  if (before === null || before.writes.length === 0) return false;
  return later.every((x) => JSON.stringify(triggerShape(x)) === JSON.stringify(before));
}

/** Applies one step the way `wrangler d1 migrations apply` does: statement by statement, stopping at the first failure. `Database.exec` on a whole file runs past a failing statement, so a file-at-once apply cannot stand in for the production applier. */
const step = (sqlite: Database, s: SchemaStep): void => { for (const statement of s.statements) sqlite.exec(statement); };

describe('versioned schema steps', () => {
  it('adds restore progress without claiming or rewriting existing history', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 36));
      sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'old', 1)`);
      sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_old', 'old', 'built-in', 1, 1)`);
      sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, status, started_at)
        VALUES ('proj_1', 'run_old', 'agent_old', 'completed', 1)`);
      sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at)
        VALUES ('proj_1', 'run_old', 'agent_old', 'note', 'Existing history', 1)`);
      const before = sqlite.query('SELECT * FROM agent_reports').all();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(37));
      expect(sqlite.query('SELECT * FROM agent_reports').all()).toEqual(before.map((row) => ({ ...(row as Record<string, unknown>), audit: null })));
      expect(sqlite.query('SELECT * FROM backup_restore_progress').all()).toEqual([]);
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('names each claimed machine in v59 after its newest credential\'s label, a live one ahead of a revoked one, and leaves a machine with none unnamed', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 58));
      sqlite.run(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_1', 'mem_1', 1, NULL)`);
      sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('m_live', 'mem_1', 1), ('m_revoked', 'mem_1', 1), ('m_none', 'mem_1', 1)`);
      const credential = (id: string, machine: string, label: string | null, issuedAt: number, revokedAt: number | null) =>
        sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, issued_at, expires_at, revoked_at, lineage_root, lineage_started_at)
          VALUES (?, 'mem_1', ?, ?, ?, ?, 9, ?, ?, 1)`, [id, id.padEnd(64, '0'), machine, label, issuedAt, revokedAt, id]);
      // The newer credential is revoked, so the older live one names the machine.
      credential('mt_a', 'm_live', 'studio', 1, null);
      credential('mt_b', 'm_live', 'studio-later', 5, 6);
      credential('mt_c', 'm_live', null, 7, null);
      // Every credential revoked: the newest labelled one names it.
      credential('mt_d', 'm_revoked', 'old-box', 1, 2);
      credential('mt_e', 'm_revoked', 'newer-box', 3, 4);
      credential('mt_f', 'm_none', null, 1, null);
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(59));
      expect(sqlite.query('SELECT machine_id, label FROM machine_claims ORDER BY machine_id').all())
        .toEqual([{ machine_id: 'm_live', label: 'studio' }, { machine_id: 'm_none', label: null }, { machine_id: 'm_revoked', label: 'newer-box' }]);
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('adds `rotates` to v52: every existing credential keeps rotating, and a new row rotates unless its insert says otherwise', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 51));
      sqlite.run(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_1', 'mem_1', 1, NULL)`);
      sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at)
        VALUES ('mt_old', 'mem_1', ?, 'machine_1', 1, 2, 'mt_old', 1)`, ['a'.repeat(64)]);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM member_credentials').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(52));
      expect(sqlite.query('SELECT * FROM member_credentials').get()).toEqual({ ...before, rotates: 1 });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
      sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at)
        VALUES ('mt_new', 'mem_1', ?, 'machine_1', 1, 2, 'mt_new', 1)`, ['b'.repeat(64)]);
      sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at, rotates)
        VALUES ('mt_fixed', 'mem_1', ?, 'machine_1', 1, 2, 'mt_fixed', 1, 0)`, ['c'.repeat(64)]);
      expect(sqlite.query('SELECT id, rotates FROM member_credentials ORDER BY id').all()).toEqual([{ id: 'mt_fixed', rotates: 0 }, { id: 'mt_new', rotates: 1 }, { id: 'mt_old', rotates: 1 }]);
    } finally { sqlite.close(); }
  });

  it('adds a recorded backup digest to v40 without inventing one for an existing backup, and admits only a hex SHA-256', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 40));
      sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned)
        VALUES ('bk_old', 'backups/lineage__1__bk_old.jsonl', 1, 40, '{}', 13, 'mem_1', 1)`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM backups').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(41));
      expect(sqlite.query('SELECT * FROM backups').get()).toEqual({ ...before, sha256: null });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
      const insert = (sha256: string) => sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256)
        VALUES (?, 'backups/lineage__2__bk_new.jsonl', 2, 40, '{}', 41, 'mem_1', 0, ?)`, [`bk_${sha256.length}`, sha256]);
      for (const invalid of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) expect(() => insert(invalid)).toThrow('CHECK constraint failed');
      insert('a'.repeat(64));
    } finally { sqlite.close(); }
  });

  it('adds the object lifecycle to v41: an existing blob keeps its legacy object name, and every new table and guard admits only its grammar', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 41));
      sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES ('proj_1', ?, 3, 'text/plain', 't1', 1)`, ['a'.repeat(64)]);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM blobs').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(42));
      expect(sqlite.query('SELECT * FROM blobs').get()).toEqual({ ...before, generation: null });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
      const generation = (value: string) => sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
        VALUES ('proj_1', ?, 3, 'text/plain', 't1', 1, ?)`, [`${value.length}`.padStart(64, 'b'), value]);
      for (const invalid of ['A1b2c3d4-0000-4000-8000-000000000000', 'short', `${'0'.repeat(35)}/`]) expect(() => generation(invalid)).toThrow('CHECK constraint failed');
      generation(crypto.randomUUID());
      expect(() => sqlite.run(`INSERT INTO object_releases (physical, kind, created_at) VALUES ('p/k', 'other', 1)`)).toThrow('CHECK constraint failed');
      sqlite.run(`INSERT INTO recovery_holds (token, acquired_at) VALUES ('h1', 1)`);
      expect(() => sqlite.run(`INSERT INTO recovery_holds (token, acquired_at) VALUES ('h2', 2)`)).toThrow('UNIQUE constraint failed');
      sqlite.run(`UPDATE recovery_holds SET released_at = 3 WHERE token = 'h1'`);
      sqlite.run(`INSERT INTO recovery_holds (token, acquired_at) VALUES ('h2', 4)`);
      for (const value of [null, 'k']) expect(() => sqlite.run('INSERT INTO restore_reference_guard (missing) VALUES (?)', [value])).toThrow('constraint failed');
      // The fence: a row without a generation cannot be registered any more, the legacy row stands, and a generation row
      // leaves only once its exact stored object is journaled. A legacy row is not fenced.
      expect(() => sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES ('proj_1', ?, 3, 'text/plain', 't1', 1)`, ['c'.repeat(64)]))
        .toThrow('blob rows register a generation');
      const fenced = sqlite.query<{ key: string; generation: string }, []>('SELECT key, generation FROM blobs WHERE generation IS NOT NULL').get()!;
      expect(() => sqlite.run('DELETE FROM blobs WHERE key = ?', [fenced.key])).toThrow('blob rows leave through the release journal');
      sqlite.run(`INSERT INTO object_releases (physical, kind, created_at) VALUES (?, 'blob', 1)`, [`proj_1/${fenced.key}~${fenced.generation}`]);
      sqlite.run('DELETE FROM blobs WHERE key = ?', [fenced.key]);
      sqlite.run('DELETE FROM blobs WHERE key = ?', ['a'.repeat(64)]);
      expect(sqlite.query('SELECT COUNT(*) AS n FROM blobs').get()).toEqual({ n: 0 });
    } finally { sqlite.close(); }
  });

  it('fills a session\'s missing agent from the one agent its transcripts name, and touches nothing else', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 39));
      const session = (id: string, agent: string | null) => sqlite.run(
        `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, title, titled_by, agent)
         VALUES ('proj_1', ?, 'm1', 't1', 1, 2, 2, 'Kept title', 'mem_1', ?)`, [id, agent]);
      const transcript = (session: string, id: string, agent: string | null) => sqlite.run(
        `INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, first_received_at, last_received_at, token_id)
         VALUES ('proj_1', ?, ?, 'm1', ?, 10, 10, 1, 2, 't1')`, [id, session, agent]);
      session('one-agent', null); transcript('one-agent', 'tx1', 'codex');
      session('two-transcripts-one-agent', null); transcript('two-transcripts-one-agent', 'tx2', 'claude-code'); transcript('two-transcripts-one-agent', 'tx3', 'claude-code');
      session('two-agents', null); transcript('two-agents', 'tx4', 'codex'); transcript('two-agents', 'tx5', 'claude-code');
      session('unnamed-transcript', null); transcript('unnamed-transcript', 'tx6', null);
      session('no-transcript', null);
      session('already-named', 'cursor'); transcript('already-named', 'tx7', 'codex');
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions ORDER BY session_id').all();
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(40));
      const after = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions ORDER BY session_id').all();
      const agents = Object.fromEntries(after.map((row) => [row.session_id, row.agent]));
      expect(agents).toEqual({ 'one-agent': 'codex', 'two-transcripts-one-agent': 'claude-code', 'two-agents': null, 'unnamed-transcript': null, 'no-transcript': null, 'already-named': 'cursor' });
      // The v45 presentation columns arrive NULL on every existing session: a backfill would be history the parse has not read.
      expect(after.map((row) => ({ ...row, agent: null }))).toEqual(before.map((row) => ({ ...row, agent: null, occurred_started_at: null, occurred_ended_at: null, titling_attempts: 0, working_since: null, last_turn_end_at: null, last_live_received_at: null, title_material_at: null, launch_parent_session_id: null })));
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
      expect(sqlite.query('SELECT * FROM sessions ORDER BY session_id').all()).toEqual(after);
    } finally { sqlite.close(); }
  });

  it('adds who ended a session to v38 while preserving every ended and titled session as it stands', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 38));
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, title, summary, titled_at, titled_by)
        VALUES ('proj_1', 'old', 'm1', 't1', 1, 2, 2, 'Existing title', 'Existing summary', 2, 'mem_1')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions').get();
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(39));
      expect(sqlite.query('SELECT * FROM sessions').get()).toEqual({ ...before, ended_by: null, occurred_started_at: null, occurred_ended_at: null, titling_attempts: 0, working_since: null, last_turn_end_at: null, last_live_received_at: null, title_material_at: null, launch_parent_session_id: null });
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('adds title request tracking without enqueueing or modifying historical sessions', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 35));
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, title, summary)
        VALUES ('proj_1', 'old', 'm1', 't1', 1, 2, 2, 'Existing title', 'Existing summary')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM sessions').get();
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(36));
      expect(sqlite.query('SELECT * FROM sessions').get()).toEqual({ ...before, titling_requested_at: null, ended_by: null, occurred_started_at: null, occurred_ended_at: null, titling_attempts: 0, working_since: null, last_turn_end_at: null, last_live_received_at: null, title_material_at: null, launch_parent_session_id: null });
      expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
    } finally { sqlite.close(); }
  });

  it('adds the awaited size to v54 without putting any existing transcript into a wait', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 53));
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, first_received_at, last_received_at, token_id, parse_error, parse_failed_at)
        VALUES ('proj_1', 'tx_1', 's1', 'm1', 'cursor', 1000, 500, 1, 2, 't1', 'awaiting_bytes', 2)`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM transcripts').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(54));
      expect(sqlite.query('SELECT * FROM transcripts').get()).toEqual({ ...before, parse_awaited_size: null, parse_segment_lines: null, parsed_through_at: null, prompt_generation: null, prompt_identity_scheme: 'offset-v1', record_identity_scheme: 'legacy-session-v1' });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('adds parser context to v34 while preserving transcript bytes, cursor and identity', async () => {
    const sqlite = fresh();
    try {
      await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.filter(({ version }) => version <= 34));
      sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, first_received_at, last_received_at, token_id)
        VALUES ('proj_1', 'tx_1', 's1', 'm1', 'codex', 1000, 500, 1, 2, 't1')`);
      const before = sqlite.query<Record<string, unknown>, []>('SELECT * FROM transcripts').get();
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual(schemaVersionsFrom(35));
      expect(sqlite.query('SELECT * FROM transcripts').get()).toEqual({ ...before, parser_context: null, parse_awaited_size: null, parse_segment_lines: null, parsed_through_at: null, prompt_generation: null, prompt_identity_scheme: 'offset-v1', record_identity_scheme: 'legacy-session-v1' });
      expect(await applySchemaSteps(sqliteD1(sqlite))).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('invalidates only the matching project, namespace and record on release-state mutations', () => {
    const sqlite = fresh();
    try {
      for (const migration of SCHEMA_STEPS) step(sqlite, migration);
      const types = { sessions: 'session', spores: 'spore', plans: 'plan' };
      for (const project of ['one', 'two']) {
        sqlite.query('INSERT INTO projects(project_id,name,created_at) VALUES (?, ?, 1)').run(project, project);
        for (const type of Object.values(types)) for (const id of ['old', 'new']) {
          sqlite.query('INSERT INTO embedding_versions(project_id,type,record_id,revision) VALUES (?, ?, ?, ?)').run(project, type, id, 'initial');
        }
      }
      const revisions = () => new Map((sqlite.query('SELECT project_id,type,record_id,revision FROM embedding_versions').all() as
        { project_id: string; type: string; record_id: string; revision: string }[]).map(r => [`${r.project_id}/${r.type}/${r.record_id}`, r.revision]));
      const changed = (before: Map<string, string>) => [...revisions()].filter(([key, revision]) => before.get(key) !== revision).map(([key]) => key).sort();
      for (const [namespace, type] of Object.entries(types)) {
        let before = revisions();
        sqlite.query(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
          VALUES ('one', 'release', 'identity', ?, 'old', 'draft', 'high', 1, 1)`).run(namespace);
        expect(changed(before)).toEqual([`one/${type}/old`]);
        before = revisions();
        sqlite.exec("UPDATE knowledge_release_state SET project_id = 'two', namespace = 'spores', record_id = 'new'");
        expect(changed(before)).toEqual([`one/${type}/old`, 'two/spore/new']);
        before = revisions();
        sqlite.exec('DELETE FROM knowledge_release_state');
        expect(changed(before)).toEqual(['two/spore/new']);
      }
    } finally { sqlite.close(); }
  });

  it('indexes existing captured text and queues historical spilled bodies when v19 is applied', () => {
    const sqlite = fresh();
    try {
      for (const migration of SCHEMA_STEPS.filter((s) => s.version < 19)) step(sqlite, migration);
      sqlite.exec(`INSERT INTO projects(project_id,name,created_at) VALUES ('existing','Existing',1);
        INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,title) VALUES ('existing','s','m','t',1,1,'historical session');
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50000)
        INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,origin,text,content_hash,created_at,updated_at,token_id,received_at)
          SELECT 'existing','s','p'||i,'e'||i,'user','historical prompt '||i,'h'||i,1,1,'t',1 FROM n;
        UPDATE prompt_batches SET text=NULL,blob_key='legacy-body' WHERE prompt_id='p1';`);
      step(sqlite, SCHEMA_STEPS.find((s) => s.version === 19)!);
      expect(version(sqlite)).toBe('19');
      expect(sqlite.query(`SELECT COUNT(*) AS n FROM prompt_batches_fts WHERE prompt_batches_fts MATCH 'historical'`).get()).toEqual({ n: 49999 });
      expect(sqlite.query(`SELECT project_id,blob_key,complete FROM search_blob_queue`).all()).toEqual([{ project_id: 'existing', blob_key: 'legacy-body', complete: 0 }]);
      expect(sqlite.query(`SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH 'historical'`).all()).toHaveLength(1);
    } finally { sqlite.close(); }
  });
  it('stamps its version as the last statement of every step, in ascending order from 1', () => {
    SCHEMA_STEPS.forEach((step, i) => {
      expect(step.version).toBe(i + 1);
      expect(step.statements[step.statements.length - 1]).toMatch(new RegExp(`^INSERT OR REPLACE INTO schema_meta \\(key, value\\) (VALUES \\('version', '${step.version}'\\)|SELECT 'version', '${step.version}' WHERE )`));
    });
    expect(SCHEMA_STEPS[SCHEMA_STEPS.length - 1].version).toBe(SERVER_SCHEMA_VERSION);
  });

  it('renders one numbered file per step with a generated-file banner, matching the committed migrations directory byte for byte', () => {
    const files = renderMigrationFiles();
    expect(files.map((f) => f.name)).toEqual(SCHEMA_STEPS.map(migrationFileName));
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()).toEqual(files.map((f) => f.name));
    for (const f of files) {
      expect(f.sql.startsWith('-- Generated by npm run migrations:emit from src/db/schema.ts')).toBe(true);
      expect(readFileSync(join(MIGRATIONS, f.name), 'utf8')).toBe(f.sql);
    }
  });

  it('keeps every shipped migration file byte-identical to its recorded digest, so an applied step cannot be edited in place and pass as a rendered file', () => {
    const shipped = Object.keys(SHIPPED_MIGRATION_DIGESTS);
    expect(shipped).toEqual(renderMigrationFiles().map((f) => f.name));
    for (const [name, digest] of Object.entries(SHIPPED_MIGRATION_DIGESTS)) {
      expect({ name, digest: sha256(readFileSync(join(MIGRATIONS, name))) }).toEqual({ name, digest });
    }
  });

  it('converges: applied to a fresh database once or twice, or on top of a v1 or a v2 database, the schema is identical and the version is the build\'s', async () => {
    const once = fresh();
    await applySchemaSteps(sqliteD1(once));
    const twice = fresh();
    await applySchemaSteps(sqliteD1(twice));
    expect(await applySchemaSteps(sqliteD1(twice))).toEqual([]);
    const fromV1 = fresh();
    fromV1.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    fromV1.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    fromV1.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written) VALUES ('mt_1', 'proj_1', 'm', 'h', 1, NULL, 0)`).run();
    expect(await readSchemaVersion(sqliteD1(fromV1))).toBe(1);
    expect(await applySchemaSteps(sqliteD1(fromV1))).toEqual(SCHEMA_STEPS.slice(1).map((s) => s.version));
    const fromV2 = fresh();
    await applySchemaSteps(sqliteD1(fromV2), SCHEMA_STEPS.slice(0, 2));
    fromV2.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    fromV2.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written) VALUES ('mt_v2', 'proj_1', 'm', 'h', ${MEMBER_TOKEN_TTL_MS + 5_000}, NULL, 7)`).run();
    expect(await readSchemaVersion(sqliteD1(fromV2))).toBe(2);
    expect(await applySchemaSteps(sqliteD1(fromV2))).toEqual(SCHEMA_STEPS.slice(2).map((s) => s.version));
    for (const db of [once, twice, fromV1, fromV2]) {
      expect(shape(db)).toEqual(shape(once));
      expect(version(db)).toBe(String(SERVER_SCHEMA_VERSION));
    }
    expect(fromV1.query(`SELECT project_id, name FROM projects`).all()).toEqual([{ project_id: 'proj_1', name: 'one' }]);
    expect(fromV1.query(`SELECT project_id FROM member_tokens`).all()).toEqual([{ project_id: 'proj_1' }]);
    expect(await readSchemaVersion(sqliteD1(fresh()))).toBe(0);
  });

  it('retires populated v85 skill, digest, instruction and derived data through the native and D1 migration paths', async () => {
    const retired = [
      'skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage',
      'digest_extracts', 'digest_extract_revisions', 'cortex_instructions',
    ];
    for (const mode of ['native', 'd1'] as const) {
      const sqlite = fresh();
      try {
        for (const migration of SCHEMA_STEPS.filter(({ version }) => version <= 85)) step(sqlite, migration);
        sqlite.exec(`INSERT INTO projects(project_id,name,created_at) VALUES('p','Project',1);
          INSERT INTO agents(id,name,source,enabled,created_at) VALUES('a','Agent','built-in',1,1);
          INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) VALUES('p','s','t',1,1);
          INSERT INTO skill_candidates(project_id,id,agent_id,topic,rationale,created_at,updated_at) VALUES('p','c','a','topic','reason',1,1);
          INSERT INTO skill_records(project_id,id,agent_id,name,display_name,description,candidate_id,path,created_at,updated_at)
            VALUES('p','r','a','name','Name','description','c','skills/name',1,1);
          INSERT INTO skill_lineage(project_id,id,skill_id,generation,action,rationale,content_snapshot,created_at)
            VALUES('p','l','r',1,'create','reason','content',1);
          INSERT INTO skill_usage(project_id,id,skill_id,session_id,detected_at) VALUES('p','u','r','s',1);
          INSERT INTO digest_extracts(project_id,id,agent_id,tier,content,generated_at) VALUES('p','d','a',1,'digest',1);
          INSERT INTO digest_extract_revisions(project_id,agent_id,tier,content,created_at) VALUES('p','a',1,'digest',1);
          INSERT INTO cortex_instructions(project_id,id,agent_id,content,input_hash,generated_at) VALUES('p','i','a','instructions','hash',1);
          INSERT INTO embedding_versions(project_id,type,record_id,revision)
            VALUES('p','skill','r','v1'),('p','digest','d','v1'),('p','digest_extracts','d','v1');
          INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
            VALUES('p','skill','r','model','v1','source',1),('p','digest','d','model','v1','source',1),
                  ('p','digest_extracts','d','model','v1','source',1);
          INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
            VALUES('p','rs','p:skill_records:r','skill_records','r','draft','high',1,1),
                  ('p','rskill','p:skill:r','skill','r','draft','high',1,1),
                  ('p','rdigest','p:digest:d','digest','d','draft','high',1,1),
                  ('p','rd','p:digest_extracts:d','digest_extracts','d','draft','high',1,1),
                  ('p','rk','p:sessions:s','sessions','s','draft','high',1,1);`);
        const before = sqlite.query('SELECT * FROM sessions').all();
        const retainedRelease = sqlite.query("SELECT * FROM knowledge_release_state WHERE namespace='sessions'").all();
        for (const table of retired) expect((sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(1);
        if (mode === 'native') for (const migration of PRE_RETIREMENT_STEPS.filter(({ version }) => version >= 86)) sqlite.exec(renderMigrationFile(migration));
        else expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual(preRetirementVersionsFrom(86));
        expect(await applySchemaSteps(sqliteD1(sqlite), PRE_RETIREMENT_STEPS)).toEqual([]);
        sqlite.exec(renderMigrationFile(SCHEMA_STEPS[85]!));
        expect(version(sqlite)).toBe('86');
        expect(sqlite.prepare('SELECT * FROM sessions').all()).toEqual(before.map((row) => ({ ...row as Record<string, unknown>, launch_parent_session_id: null })));
        const retiredObjects = sqlite.query(`SELECT name FROM sqlite_master
          WHERE name LIKE 'skill_%' OR name LIKE 'digest_extract%' OR tbl_name = 'cortex_instructions'`).all() as { name: string }[];
        expect(retiredObjects).toEqual([]);
        expect(sqlite.query("SELECT type FROM embedding_versions WHERE type IN ('skill','digest','digest_extracts')").all()).toEqual([]);
        expect(sqlite.query("SELECT type FROM embedding_source_failures WHERE type IN ('skill','digest','digest_extracts')").all()).toEqual([]);
        expect(sqlite.query("SELECT namespace FROM knowledge_release_state WHERE namespace IN ('skill','skill_records','digest','digest_extracts')").all()).toEqual([]);
        expect(sqlite.query("SELECT * FROM knowledge_release_state WHERE namespace='sessions'").all()).toEqual(retainedRelease);
        const view = (sqlite.query(`SELECT sql FROM sqlite_master WHERE type='view' AND name='embedding_sources'`).get() as { sql: string }).sql;
        expect(view).not.toContain('skill_records');
        expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally { sqlite.close(); }
    }
  });

  it('backfills every pre-v3 token as the root of its own lineage, started one TTL before it expires, and leaves predecessor and first use unset', async () => {
    const sqlite = fresh();
    await applySchemaSteps(sqliteD1(sqlite), SCHEMA_STEPS.slice(0, 2));
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    sqlite.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written) VALUES ('mt_a', 'proj_1', 'm', 'ha', ${MEMBER_TOKEN_TTL_MS + 1_000}, NULL, 0), ('mt_b', 'proj_1', 'm', 'hb', ${MEMBER_TOKEN_TTL_MS + 2_000}, 5, 9)`).run();
    await applySchemaSteps(sqliteD1(sqlite));
    expect(sqlite.query(`SELECT id, predecessor_id, lineage_root, lineage_started_at, first_used_at, bytes_written FROM member_tokens ORDER BY id`).all()).toEqual([
      { id: 'mt_a', predecessor_id: null, lineage_root: 'mt_a', lineage_started_at: 1_000, first_used_at: null, bytes_written: 0 },
      { id: 'mt_b', predecessor_id: null, lineage_root: 'mt_b', lineage_started_at: 2_000, first_used_at: null, bytes_written: 9 },
    ]);
  });

  it('keeps earlier tables and columns except declared retirements', () => {
    const retiredAt86 = new Set([
      'skill_candidates', 'skill_records', 'skill_lineage', 'skill_usage', 'digest_extracts', 'digest_extract_revisions', 'cortex_instructions',
      ...['', '_data', '_idx', '_docsize', '_config'].map((suffix) => `skill_records_fts${suffix}`),
    ]);
    const retiredTriggersAt86 = new Set([
      'skill_records_fts_ai', 'skill_records_fts_au', 'skill_records_fts_ad',
      'skill_records_embedding_ai', 'skill_records_embedding_au', 'skill_records_embedding_ad',
    ]);
    for (let n = 2; n < SCHEMA_STEPS.length; n++) {
      const retirement = RETIREMENT_SCHEMA_STEPS.some(step => step.version === SCHEMA_STEPS[n]!.version);
      const drops = SCHEMA_STEPS[n]!.statements.filter(sql => sql.startsWith('DROP TABLE IF EXISTS ')).map(sql => sql.slice('DROP TABLE IF EXISTS '.length));
      const before = declaredColumns(SCHEMA_STEPS.slice(0, n));
      const after = declaredColumns(SCHEMA_STEPS.slice(0, n + 1));
      for (const [table, cols] of before) {
        if (table==='_v117_reference_ranges' && SCHEMA_STEPS[n]!.statements.includes('DROP TABLE _v117_reference_ranges')) { expect(after.has(table)).toBe(false); continue; }
        if ((n === 85 && retiredAt86.has(table)) || (retirement && RETIRED_CONTENT_TABLES.some(name => drops.includes(name) && (table === name || name.endsWith('_fts') && table.startsWith(name + '_'))))) {
          expect(after.has(table)).toBe(false);
          continue;
        }
        expect(after.has(table)).toBe(true);
        for (const [col, type] of cols) expect({ table, col, type: after.get(table)!.get(col) }).toEqual({ table, col, type });
      }
      // Outside the explicit v86 retirement, a step may DROP only a table it created in that same step — the guard-table
      // idiom, where a CHECK-bearing scratch table aborts the step on a precondition
      // and is cleaned up — or an index whose access path the same step replaces.
      // An index carries no data, so retiring one loses nothing a later step cannot
      // rebuild; retiring the LAST ordered path over a table does cost a read its
      // plan, so the step that drops one states the path that takes its place.
      // Anything else dropped after step 2 is contraction.
      const createdHere = new Set(
        SCHEMA_STEPS[n].statements
          .map((s) => /^CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(s)?.[1])
          .filter((t): t is string => t !== undefined),
      );
      const indexesBefore = (): Map<string, string> => declaredIndexes(SCHEMA_STEPS.slice(0, n));
      for (const [index, s] of SCHEMA_STEPS[n].statements.entries()) {
        const dropped = /^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
        if (dropped !== undefined) {
          const allowedRetirement = dropped==='_v117_reference_ranges' && retirement || (n === 85 && retiredAt86.has(dropped)) || (retirement && (RETIRED_CONTENT_TABLES as readonly string[]).includes(dropped));
          expect({ step: n + 1, dropped, allowed: createdHere.has(dropped) || allowedRetirement })
            .toEqual({ step: n + 1, dropped, allowed: true });
          continue;
        }
        const droppedIndex = /^DROP INDEX (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
        if (droppedIndex !== undefined) {
          const table = indexesBefore().get(droppedIndex) ?? null;
          const replaced = table !== null && SCHEMA_STEPS[n].statements.some((x) =>
            new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?\\w+ ON ${table}\\b`, 'i').test(x));
          expect({ step: n + 1, droppedIndex, table, replaced }).toEqual({ step: n + 1, droppedIndex, table, replaced: true });
          continue;
        }
        // A view holds no rows: dropping one loses nothing as long as the same
        // step puts it back, which is how a derived definition is replaced.
        const droppedView = /^DROP VIEW (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
        if (droppedView !== undefined) {
          const replaced = recreatedAfterDrop(SCHEMA_STEPS[n].statements, index, 'VIEW', droppedView, null);
          expect({ step: n + 1, droppedView, replaced }).toEqual({ step: n + 1, droppedView, replaced: true });
          continue;
        }
        // A trigger holds no rows either: the same step creates it again, after the drop, doing what it did.
        const droppedTrigger = /^DROP TRIGGER (?:IF EXISTS )?(\w+)/i.exec(s)?.[1];
        if (droppedTrigger !== undefined) {
          const prior = declaredTriggers(SCHEMA_STEPS.slice(0, n)).get(droppedTrigger) ?? null;
          const replaced = recreatedAfterDrop(SCHEMA_STEPS[n].statements, index, 'TRIGGER', droppedTrigger, prior);
          expect({ step: n + 1, droppedTrigger, allowed: replaced || (n === 85 && retiredTriggersAt86.has(droppedTrigger))
            || (n === 114 && V110_LEGACY_TRIGGERS.includes(droppedTrigger)) || (retirement && ((RETIRED_CONTENT_TRIGGERS as readonly string[]).includes(droppedTrigger))) })
            .toEqual({ step: n + 1, droppedTrigger, allowed: true });
          continue;
        }
        expect(s).not.toMatch(/\b(DROP|RENAME)\b/i);
      }
    }
    const stepTwo = SCHEMA_STEPS[1].statements;
    stepTwo.forEach((s, i) => {
      const dropped = /^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(s);
      if (!dropped) return;
      const scratch = stepTwo.some((x) => new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?${dropped[1]}\\b`).test(x));
      const copied = stepTwo.slice(0, i).some((prev) => new RegExp(`INSERT INTO \\w+ .* FROM ${dropped[1]}\\b`, 'is').test(prev));
      expect({ statement: s, safe: scratch || copied }).toEqual({ statement: s, safe: true });
    });
  });

  it('accepts a dropped trigger only when the step creates it again after the drop, on the same table and event and writing the same tables', () => {
    const step = SCHEMA_STEPS.find((x) => x.version === 49)!.statements;
    const prior = declaredTriggers(SCHEMA_STEPS.filter((x) => x.version < 49));
    const drops = step.flatMap((sql, i) => { const name = /^DROP TRIGGER IF EXISTS (\w+)/.exec(sql)?.[1]; return name === undefined ? [] : [{ i, name }]; });
    expect(drops.length).toBe(5);
    for (const { i, name } of drops) {
      const create = i + 1;
      const judge = (statements: string[], at = i) => recreatedAfterDrop(statements, at, 'TRIGGER', name, prior.get(name) ?? null);
      expect({ name, shipped: judge([...step]) }).toEqual({ name, shipped: true });
      // The create placed ahead of the drop leaves no trigger standing.
      const reordered = [...step]; [reordered[i], reordered[create]] = [reordered[create], reordered[i]];
      expect({ name, reordered: judge(reordered, create) }).toEqual({ name, reordered: false });
      // A body that writes nothing, and one on another event or table, is not the trigger it replaces.
      for (const [label, edit] of [
        ['no-op body', (sql: string) => sql.replace(/BEGIN[\s\S]*END$/, 'BEGIN SELECT 1; END')],
        ['another event', (sql: string) => sql.replace(/AFTER UPDATE( OF [\w\s,]+?)? ON/, 'AFTER DELETE ON')],
        ['another table', (sql: string) => sql.replace(/ ON (\w+)\n/, ' ON projects\n')],
      ] as const) {
        const edited = [...step]; edited[create] = edit(step[create]);
        expect(edited[create]).not.toBe(step[create]);
        expect({ name, label, accepted: judge(edited) }).toEqual({ name, label, accepted: false });
      }
    }
    expect(recreatedAfterDrop(['DROP VIEW IF EXISTS v', 'CREATE VIEW IF NOT EXISTS v AS SELECT 1'], 0, 'VIEW', 'v', null)).toBe(true);
    expect(recreatedAfterDrop(['CREATE VIEW IF NOT EXISTS v AS SELECT 1', 'DROP VIEW IF EXISTS v'], 1, 'VIEW', 'v', null)).toBe(false);
  });

  it('aborts step 2 on an out-of-grammar project id, leaving the database at v1, and completes once the row is fixed', () => {
    const good = fresh();
    good.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    good.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj-1.ok', 'one', 0)`).run();
    step(good, SCHEMA_STEPS[1]);
    expect(version(good)).toBe('2');

    const bad = fresh();
    bad.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    bad.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('bad/id', 'one', 0)`).run();
    expect(() => step(bad, SCHEMA_STEPS[1])).toThrow(/CHECK constraint failed/);
    expect(version(bad)).toBe('1');

    bad.query(`UPDATE projects SET project_id = 'good.id' WHERE project_id = 'bad/id'`).run();
    step(bad, SCHEMA_STEPS[1]);
    expect(version(bad)).toBe('2');
    expect(bad.query(`SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger'`).get()).toEqual({ c: 2 });
  });

  it('aborts step 2 on a v1 session whose machine identity cannot be backfilled, and completes once the row is repaired', () => {
    // Identity binding reads `sessions.machine_id`. A session left without one refuses every later write to itself,
    // and no member request can repair it, so the step stops rather than carry the row forward.
    const sqlite = fresh();
    sqlite.exec(renderMigrationFile(SCHEMA_STEPS[0]));
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'one', 0)`).run();
    sqlite.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at) VALUES ('mt_named', 'proj_1', 'machine_1', 'h1', 9)`).run();
    sqlite.query(`INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at) VALUES ('mt_anon', 'proj_1', NULL, 'h2', 9)`).run();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 'sess_ok', NULL, 'mt_named', 0, 0)`).run();
    sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 'sess_orphan', NULL, 'mt_anon', 0, 0)`).run();

    // The guard runs ahead of every ADD COLUMN, so the aborted step leaves nothing behind and re-applies whole.
    expect(() => step(sqlite, SCHEMA_STEPS[1])).toThrow(/CHECK constraint failed/);
    expect(version(sqlite)).toBe('1');
    expect(sqlite.query(`SELECT COUNT(*) c FROM pragma_table_info('events') WHERE name = 'producer_adapter'`).get()).toEqual({ c: 0 });

    sqlite.query(`UPDATE sessions SET machine_id = 'machine_recovered' WHERE session_id = 'sess_orphan'`).run();
    step(sqlite, SCHEMA_STEPS[1]);
    expect(version(sqlite)).toBe('2');
    // The backfill carried the session whose token names a machine; the repair stands on the one it could not reach.
    expect(sqlite.query(`SELECT session_id, machine_id FROM sessions ORDER BY session_id`).all())
      .toEqual([{ session_id: 'sess_ok', machine_id: 'machine_1' }, { session_id: 'sess_orphan', machine_id: 'machine_recovered' }]);
  });

  it('applies the project-id grammar as a CHECK on every table created or rebuilt by step 2 that has a project_id column', async () => {
    const source = sqliteEnv();
    const promptId = crypto.randomUUID();
    const writerRows = new Map<string, Record<string, unknown>>();
    try {
      expect(await ingestEvent(source.db, { projectId: 'proj_1', machineId: 'machine', tokenId: 'capture', now: 1, bodyBytes: 0, writeOrigin: 'server' }, {
        eventId: crypto.randomUUID(), sessionId: 'grammar-session', kind: 'prompt', createdAt: 1, channel: 'cli',
        producer: { adapter: 'claude-code', version: 'test' }, payload: { promptId, text: 'Grammar fixture', origin: 'user' },
      })).toMatchObject({ persisted: true, projected: true });
      await publishFixture(source);
      expect(await markPromptProcessed(source.db, { projectId: 'proj_1' }, promptId)).toBe(true);
      writerRows.set('learning_sessions', source.sqlite.query('SELECT * FROM learning_sessions').get() as Record<string, unknown>);
      writerRows.set('extraction_acks', source.sqlite.query('SELECT * FROM extraction_acks').get() as Record<string, unknown>);
    } finally { source.sqlite.close(); }
    const sqlite = fresh();
    for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
    // The probe inserts one synthetic row per table to observe the CHECK. Parent
    // rows for its foreign keys do not exist, and an FK refusal would mask the
    // admission this asserts, so the probe measures the CHECK alone.
    sqlite.exec('PRAGMA foreign_keys = OFF');
    const tables = (sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
    const checked: string[] = [];
    for (const t of tables) {
      const cols = sqlite.query(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null }[];
      if (!cols.some((c) => c.name === 'project_id')) continue;
      if (t === 'member_tokens' || t === 'sessions' || t === 'events' || (RETIRED_CONTENT_TABLES as readonly string[]).includes(t)) continue;
      sqlite.exec('SAVEPOINT grammar_probe');
      const insert = (projectId: string) => {
        const specimen = writerRows.get(t);
        if (specimen !== undefined) {
          const row = { ...specimen, project_id: projectId };
          const fields = Object.keys(row);
          sqlite.query(`INSERT INTO ${t} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...Object.values(row) as never[]);
          return;
        }
        const names = cols.map((c) => c.name);
        // A blob row registers a generation: a UUID.
        // A step row names a kind and an outcome from its own vocabulary.
        const values = cols.map((c) => (c.name === 'project_id' ? `'${projectId}'` : t === 'blobs' && c.name === 'generation' ? `'${crypto.randomUUID()}'`
          : t === 'transcripts' && c.name === 'parser_context' ? `'{}'`
          : t === 'transcript_parser_state_chunks' && c.name === 'chunk_count' ? '1'
          : t === 'embedding_work_state' && c.name === 'kind' ? `'embedding'`
          : t === 'raw_resources' && c.name === 'provenance' ? `'missing'`
          : t === 'raw_resources' && c.name === 'kind' ? `'blob'` : t === 'raw_resources' && c.name === 'classification' ? `'raw'`
          : t === 'processed_resources' && c.name === 'kind' ? `'plan'` : t === 'processed_resources' && c.name === 'classification' ? `'processed'`
          : t === 'agent_runs' && (c.name === 'leased_runner_id' || c.name === 'leased_runner_credential_id') ? 'NULL'
          : t === 'agent_runs' && c.name === 'origin' ? "'manual'"
          : t === 'agent_run_attempts' && c.name === 'settled_seq' ? 'NULL'
          : t === 'agent_run_attempts' && (c.name === 'estimate_usd' || c.name === 'cost_usd') ? '0'
          : t === 'agent_run_attempts' && c.name === 'owner_kind' ? `'member'` : t === 'agent_run_attempts' && c.name === 'runner_id' ? 'NULL'
          : t === 'agent_run_steps' && c.name === 'kind' ? `'read'` : t === 'agent_run_steps' && c.name === 'outcome' ? `'ok'` : t === 'registered_content_proofs' && c.name === 'durable' ? '1'
          : t === 'content_scan_checkpoints' && c.name === 'source_kind' ? "'event'"
          : t === 'raw_archive_refs' && c.name === 'source_kind' ? "'transcript'"
          : t === 'raw_archive_refs' && c.name === 'disposition' ? "'hot'"
          : t === 'injection_served_items' && c.name === 'kind' ? "'plan'"
          : t === 'session_artifacts' && c.name === 'kind' ? "'pr'" : t === 'session_artifacts' && c.name === 'url' ? "'https://x'"
          : t === 'prompt_context_answers' && c.name === 'outcome' ? "'empty'"
          : t === 'turn_cards' && c.name === 'state' ? "'pending'" : t === 'turn_cards' && c.name === 'signal' ? "'none'"
          : (t === 'session_documents' || t === 'session_chunks') && c.name === 'state' ? "'live'" : t === 'transcript_publication' && c.name === 'state' ? "'active'"
          : t === 'session_chunks' && c.name === 'kind' ? "'page'" : t === 'session_chunks' && c.name === 'encoding' ? "'identity'"
          : c.name === 'scope_reason' || c.name.startsWith('delivered_') || c.name === 'claim' ? 'NULL' : c.name === 'ask_protocol' ? "'v1'"
          : t === 'archive_bundles' && (c.name === 'version' || c.name === 'entry_count') ? '1' : c.type === 'INTEGER' ? '0' : `'x'`));
        sqlite.query(`INSERT INTO ${t} (${names.join(', ')}) VALUES (${values.join(', ')})`).run();
      };
      expect(() => insert('bad/id')).toThrow(/CHECK constraint failed/);
      expect(() => insert('a'.repeat(65))).toThrow(/CHECK constraint failed/);
      // `.` and `..` sit inside the character class but are path segments wherever a project id reaches one.
      expect(() => insert('.')).toThrow(/CHECK constraint failed/);
      expect(() => insert('..')).toThrow(/CHECK constraint failed/);
      expect(() => insert('ok.id-1_A')).not.toThrow();
      sqlite.exec('ROLLBACK TO grammar_probe; RELEASE grammar_probe');
      checked.push(t);
    }
    expect(checked.sort()).toEqual([
      'agent_reports', 'agent_run_attempts', 'agent_run_events', 'agent_run_steps', 'agent_run_write_intents', 'agent_runs', 'agent_state', 'agent_turns',
      'event_refs', 'archive_bundles', 'attachments', 'blob_release_candidates', 'blob_reservations', 'blobs', 'canopy_maps', 'content_scan_checkpoints', 'embedding_cursors', 'embedding_hubness_members', 'embedding_hubness_work', 'embedding_receipts', 'embedding_source_failures', 'embedding_versions', 'embedding_work_state', 'enrollment_authorities', 'external_grants',
      'extraction_acks', 'injection_served_items', 'knowledge_git_provenance', 'knowledge_release_state', 'myco_tool_calls', 'plans', 'prepared_archive_bundles', 'processed_resources', 'project_capabilities', 'project_release_provenance', 'project_remotes', 'project_repositories', 'project_session_counts', 'projects',
       'prompt_context_answers', 'prompt_identity_conflicts',  'publish_queue', 'raw_archive_refs', 'raw_resources', 'registered_content_proofs', 'resolution_events',  'retired_objects', 'run_reads', 'run_served_material', 'search_blob_chunks', 'search_blob_queue', 'session_artifacts', 'session_chunks', 'session_documents', 'session_injections', 'session_pages', 'session_paths', 'session_prompts', 'session_read_facts', 'session_sealed_records', 'session_tombstones',
      'spore_injections', 'spores', 'storage_cleanup_omissions', 'storage_cleanup_queue', 'tags',   'transcript_publication', 'transcript_segments', 'transcripts',
      'learning_sessions', 'turn_cards',
    ].sort());
  });
});

describe('runner sign-in schema upgrade', () => {
  it('defaults a populated v87 runner to its own sign-in on native and emitted D1 migrations', async () => {
    for (const target of ['native', 'd1'] as const) {
      const db = new Database(':memory:');
      try {
        const previous = SCHEMA_STEPS.filter(step => step.version <= 87);
        if (target === 'native') await applySchemaSteps(sqliteD1(db), previous);
        else for (const file of renderMigrationFiles().filter(file => file.name < '0088')) db.exec(file.sql);
        db.run("INSERT INTO runners(id,name,created_at) VALUES ('rn_existing','existing',1)");
        if (target === 'native') await applySchemaSteps(sqliteD1(db), SCHEMA_STEPS.filter(step => step.version === 88));
        else db.exec(readFileSync(join(MIGRATIONS, '0088_v88.sql'), 'utf8'));
        expect(db.query("SELECT name,credential_choices FROM runners WHERE id = 'rn_existing'").get())
          .toEqual({ name: 'existing', credential_choices: '{}' });
        expect(version(db)).toBe('88');
      } finally { db.close(); }
    }
  });
});

it('schema 101 only adds default-zero spore revisions and a stable dispatch boundary', async () => {
  const sqlite = fresh();
  const db = sqliteD1(sqlite);
  try {
    await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version < 101));
    sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES ('proj_guard','guard',1)");
    sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES ('guard','guard','built-in',1,1)");
    sqlite.run("INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,created_at) VALUES ('proj_guard','old','guard','gotcha','superseded','held',1)");
    const before = sqlite.query('SELECT * FROM spores').get() as Record<string, unknown>;
    const indexes = sqlite.query("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='spores' ORDER BY name").all();
    expect(await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version === 101))).toEqual([101]);
    expect(sqlite.query('SELECT * FROM spores').get()).toEqual({ ...before, revision: 0 });
    expect(sqlite.query("SELECT name,sql FROM sqlite_master WHERE type='index' AND tbl_name='spores' ORDER BY name").all()).toEqual(indexes);
    const stamp = sqlite.query("SELECT value FROM schema_meta WHERE key='guard_enabled_at'").get();
    expect(Number((stamp as { value: string }).value)).toBeGreaterThan(0);
    expect(await applySchemaSteps(db, SCHEMA_STEPS.filter(step => step.version === 101))).toEqual([]);
    expect(sqlite.query("SELECT value FROM schema_meta WHERE key='guard_enabled_at'").get()).toEqual(stamp);
  } finally { sqlite.close(); }
});

it('schema 107 installs the source-range path on empty and populated prompt storage on native and emitted D1 migrations', async () => {
  const range = "SELECT sql FROM sqlite_master WHERE name='idx_view_prompts_source_range'";
  for (const target of ['native', 'd1'] as const) for (const populated of [false, true]) {
    const db = new Database(':memory:');
    try {
      const previous = SCHEMA_STEPS.filter(step => step.version <= 106);
      if (target === 'native') await applySchemaSteps(sqliteD1(db), previous);
      else for (const file of renderMigrationFiles().filter(file => file.name < '0107')) db.exec(file.sql);
      if (populated) db.run(`INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,content_hash,created_at,updated_at,received_at)
        VALUES ('proj_range','inst','sess','prompt','live','h',1,1,1)`);
      const apply = target === 'native'
        ? () => applySchemaSteps(sqliteD1(db), SCHEMA_STEPS.filter(step => step.version === 107))
        : async () => {
          // Bun's multi-statement exec reports only the last statement's error, so each emitted statement runs alone.
          const statements = readFileSync(join(MIGRATIONS, '0107_v107.sql'), 'utf8').split(/;\n/).map(sql => sql.replace(/^(?:\s*--[^\n]*\n)*/, '').trim()).filter(Boolean);
          db.transaction(() => { for (const sql of statements) db.run(sql); })();
        };
      await apply();
      expect({ target, version: version(db), index: db.query(range).get() }).toEqual({ target, version: '107',
        index: { sql: 'CREATE INDEX idx_view_prompts_source_range ON view_prompts(project_id,instance_id,source_transcript_id,source_offset,source_end,prompt_id)' } });
    } finally { db.close(); }
  }
});

it('retires content storage only after documents are live, preserving the catalog and capture', () => {
  const sqlite = fresh();
  try {
    for (const prior of SCHEMA_STEPS.filter(step => step.version < 117)) step(sqlite, prior);
    sqlite.run(`INSERT INTO projects(project_id,name,created_at) VALUES('retirement','Retirement',0)`);
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES('retirement','session','machine','token',0,0)`);
    sqlite.run(`INSERT INTO session_documents(project_id,session_id,state,updated_at) VALUES('retirement','session','convert',0)`);
    sqlite.run(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,token_id,text,origin,created_at,updated_at,received_at,content_hash)
      VALUES('retirement','prompt','session','event','token','retained body','user',1,1,1,'hash')`);
    const retirement = SCHEMA_STEPS.find(step => step.version === 117)!;
    expect(() => step(sqlite, retirement)).toThrow('documents_retirement_incomplete');
    expect(version(sqlite)).toBe('116');
    sqlite.run(`UPDATE session_documents SET state='live',generation=1 WHERE project_id='retirement'`);
    sqlite.run(`UPDATE raw_provenance_backfill SET source=5,cursor_project='retirement',cursor_id='old',complete=0 WHERE id=1`);
    sqlite.run(`INSERT INTO view_instances(project_id,session_id,instance_id,parser_version,base,state,created_at) VALUES('retirement','session','instance',1,'full','live',1)`);
    sqlite.run(`INSERT INTO view_checkpoints(project_id,session_id,instance_id,transcript_id,ordinal,start_offset,parsed_offset) VALUES('retirement','session','instance','transcript',0,0,10)`);
    sqlite.run(`INSERT INTO view_checkpoint_chunks(project_id,session_id,instance_id,transcript_id,cursor_offset,chunk_index,chunk_count,payload) VALUES('retirement','session','instance','transcript',10,0,1,'{}')`);
    for (const next of SCHEMA_STEPS.filter(step => step.version >= 117)) step(sqlite, next);
    for (const table of RETIRED_CONTENT_TABLES) expect(sqlite.query(`SELECT 1 FROM sqlite_master WHERE name=?`).get(table)).not.toBeNull();
    expect(sqlite.query(`SELECT session_id FROM sessions WHERE project_id='retirement'`).get()).toEqual({session_id:'session'});
    expect(sqlite.query(`SELECT generation FROM session_documents WHERE project_id='retirement'`).get()).toEqual({generation:1});
    expect(sqlite.query(`SELECT source,cursor_project,cursor_id,complete FROM raw_provenance_backfill WHERE id=1`).get())
      .toEqual({source:0,cursor_project:'',cursor_id:'',complete:0});
  } finally { sqlite.close(); }
});

it('backfills only the reference catalog and retains content tables', () => {
  for (const {statements} of RETIREMENT_SCHEMA_STEPS) for(const sql of statements) {
    expect(sql).not.toMatch(/UPDATE events|CREATE (?:UNIQUE )?INDEX[^;]* ON events/i);
    const dropped=/^DROP TABLE (?:IF EXISTS )?(\w+)/i.exec(sql)?.[1];
    if(dropped!==undefined)expect(['_v117_documents_guard','_v117_reference_ranges']).toContain(dropped);
  }
});
