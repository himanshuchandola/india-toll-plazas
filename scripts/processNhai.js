const fs = require('fs');
const path = require('path');
const { assertNotRegressed, writeJsonIfValid } = require('./lib/datasetGuard');

const FIELD_MAPPING = {
  'tollplaza_id': 'tollplaza_id',
  'tollplaza_name': 'tollplaza_name',
  'tollplaza_code': 'tollplaza_code',
  'state_name': 'state_name',
  'latitude': 'latitude',
  'longitude': 'longitude',
  'nh_no': 'nh_no',
  'Location': 'location',
  'Chainage': 'chainage',
  'TollableLength': 'tollable_length',
  'CarRate_single': 'car_single',
  'CarRate_multi': 'car_return',
  'CarRate_mth': 'car_monthly',
  'CarRate_comm_reg': 'car_commercial',
  'LCVRate_single': 'lcv_single',
  'LCVRate_multi': 'lcv_return',
  'LCVRate_Mth': 'lcv_monthly',
  'LCVRate_comm_reg': 'lcv_commercial',
  'BusRate_single': 'bus_single',
  'BusRate_multi': 'bus_return',
  'BusRate_Mth': 'bus_monthly',
  'BusRate_comm_reg': 'bus_commercial',
  'MultiAxleRate_single': 'multiaxle_single',
  'MultiAxleRate_multi': 'multiaxle_return',
  'MultiAxleRate_Mth': 'multiaxle_monthly',
  'MultiAxleRate_comm_reg': 'multiaxle_commercial',
  'FourToSixExel_Single': 'axle_4_6_single',
  'FourToSixExel_Return': 'axle_4_6_return',
  'FourToSixExel_Monthly': 'axle_4_6_monthly',
  'FourToSixExel_comm_reg': 'axle_4_6_commercial',
  'SevenOrmoreExel_Single': 'axle_7_plus_single',
  'SevenOrmoreExel_Return': 'axle_7_plus_return',
  'SevenOrmoreExel_Monthly': 'axle_7_plus_monthly',
  'SevenOrmoreExel_comm_reg': 'axle_7_plus_commercial',
  'HCM_EME_Single': 'hcm_single',
  'HCM_EME_Return': 'hcm_return',
  'hcm_eme_monthly': 'hcm_monthly',
  'hcm_eme_comm_reg': 'hcm_commercial',
  'DtEffectiveRates': 'rate_effective_date',
  'DtRateRevision': 'rate_revision_date',
  'concessions': 'concessions_info',
  'TypeOfProject': 'project_type',
  'Project_Lane': 'project_lanes',
  'Toll_Lane': 'toll_lanes',
  'active': 'active',
  'omtcontractorname': 'contractor_name',
  'inchargename': 'incharge_name',
  'inchargecontactdetail': 'incharge_contact',
  'helplinenumber_crane': 'helpline_crane',
  'helplinenumber_ambulance': 'helpline_ambulance',
  'helplinenumber_routepetrol': 'helpline_patrol',
  'Emergency_Services': 'emergency_services',
  'NearestPoliceStationName': 'nearest_police_station',
  'NearestPoliceStationNo': 'police_station_contact',
  'NearestHospitals': 'nearest_hospitals'
};

function normalizeNhaiData(rawPlaza) {
  const normalized = {};

  // Add metadata
  normalized.data_source = 'nhai';
  normalized.data_confidence = 'complete';

  // Map fields
  for (const [apiField, normalizedField] of Object.entries(FIELD_MAPPING)) {
    const value = rawPlaza[apiField];
    normalized[normalizedField] = value ?? null;
  }

  // Add timestamp
  normalized.last_updated = new Date().toISOString();

  return normalized;
}

/** Validates the raw JSON pulled from .temp_raw_details.json before it is ever normalized. */
function validateRawPlazas(rawPlazas) {
  if (!Array.isArray(rawPlazas)) {
    throw new Error('Raw details file does not contain a JSON array');
  }
  if (rawPlazas.length === 0) {
    throw new Error('Raw details file contains zero plazas');
  }
  const missingId = rawPlazas.filter(p => !p || typeof p !== 'object' || p.tollplaza_id == null);
  if (missingId.length > 0) {
    throw new Error(`${missingId.length} raw plaza record(s) are missing a tollplaza_id`);
  }
}

/** Validates normalized records before they are allowed to overwrite nhai.json. */
function validateNormalizedPlazas(plazas) {
  const invalid = plazas.filter(p => {
    if (!p.tollplaza_id || !p.tollplaza_name) return true;
    if (p.latitude != null && Number.isNaN(Number(p.latitude))) return true;
    if (p.longitude != null && Number.isNaN(Number(p.longitude))) return true;
    return false;
  });
  if (invalid.length > 0) {
    throw new Error(`${invalid.length} normalized plaza record(s) failed validation (missing id/name, or non-numeric coordinates)`);
  }
}

async function processNhai(options = {}) {
  const maxDropRatio = options.maxDropRatio ?? 0.15;
  const rawFile = options.rawFile || path.join(__dirname, '../data/sources/.temp_raw_details.json');
  const nhaiFile = options.nhaiFile || path.join(__dirname, '../data/sources/nhai.json');

  try {
    console.log('Processing NHAI data...');

    if (!fs.existsSync(rawFile)) {
      throw new Error(
        'Raw details file not found. Run fetchNhaiData.js first ' +
        '(it always writes this file once it starts fetching, even on partial failure).'
      );
    }

    let rawPlazas;
    try {
      rawPlazas = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
    } catch (error) {
      throw new Error(`Raw details file contains invalid JSON: ${error.message}`);
    }

    validateRawPlazas(rawPlazas);

    const normalizedPlazas = rawPlazas.map(normalizeNhaiData);
    validateNormalizedPlazas(normalizedPlazas);

    let previousCount = 0;
    if (fs.existsSync(nhaiFile)) {
      try {
        previousCount = JSON.parse(fs.readFileSync(nhaiFile, 'utf8')).length;
      } catch {
        previousCount = 0;
      }
    }
    assertNotRegressed(normalizedPlazas.length, previousCount, 'NHAI dataset', maxDropRatio);

    console.log(`Processed ${normalizedPlazas.length} NHAI toll plazas (previous: ${previousCount})`);

    const sourcesDir = path.dirname(nhaiFile);
    if (!fs.existsSync(sourcesDir)) {
      fs.mkdirSync(sourcesDir, { recursive: true });
    }

    // Validation already ran above; this call re-runs it defensively and then
    // writes via write-temp-then-rename, so nhai.json is only ever replaced
    // once a valid result exists on disk — a thrown error here leaves the
    // existing nhai.json completely untouched.
    writeJsonIfValid(nhaiFile, normalizedPlazas, {
      pretty: true,
      validateFn: validateNormalizedPlazas,
    });

    console.log(`Saved to ${nhaiFile}`);
    return normalizedPlazas;
  } catch (error) {
    console.error('Error processing NHAI data:', error.message);
    console.error('Existing nhai.json was left untouched.');
    if (require.main === module) {
      process.exit(1);
    }
    throw error;
  }
}

if (require.main === module) {
  processNhai();
}

module.exports = { processNhai, normalizeNhaiData, validateRawPlazas, validateNormalizedPlazas };
