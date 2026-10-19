// The shared document vocabulary (sidon-ai's TYPE_SCHEMAS, upload.ts). The
// fields drive extraction only; marina requirement types must be one of these.
const f = (name, label, type = 'string') => ({ name, label, type });

const TYPES = {
  insurance: { label: 'Boat insurance certificate', fields: [f('insurer', 'Insurance company'), f('policy_number', 'Policy number'), f('boat_name', 'Insured boat name'), f('coverage_amount', 'Coverage amount'), f('expiry_date', 'Expiry date', 'date')] },
  acord25: { label: 'ACORD 25 Certificate of Liability Insurance', fields: [f('producer', 'Producer / broker'), f('insured_name', 'Insured name'), f('insured_address', 'Insured address'), f('insurer', 'Insurer letter A company'), f('policy_number', 'Policy number'), f('effective_date', 'Policy effective date', 'date'), f('expiry_date', 'Policy expiration date', 'date'), f('each_occurrence', 'Each occurrence limit'), f('general_aggregate', 'General aggregate limit'), f('additional_insured', 'Additional insured name (certificate holder)'), f('description_of_operations', 'Description of operations / vessel')] },
  registration: { label: 'Boat registration', fields: [f('registration_number', 'Registration number'), f('boat_name', 'Boat name'), f('owner_name', 'Owner name'), f('flag_state', 'Flag state'), f('loa_metres', 'LOA (m)', 'number'), f('beam_metres', 'Beam (m)', 'number')] },
  uscg_cod: { label: 'USCG Certificate of Documentation', fields: [f('official_number', 'Official number'), f('vessel_name', 'Vessel name'), f('hailing_port', 'Hailing port'), f('owner_name', 'Owner name'), f('hull_id', 'Hull identification number (HIN)'), f('service_endorsement', 'Service / endorsement (Recreational, Coastwise, Fisheries)'), f('year_built', 'Year built', 'number'), f('length_ft', 'Length (ft)', 'number'), f('breadth_ft', 'Breadth (ft)', 'number'), f('gross_tons', 'Gross tons', 'number'), f('net_tons', 'Net tons', 'number'), f('issue_date', 'Issue date', 'date'), f('expiry_date', 'Expiration date', 'date')] },
  passport: { label: 'Passport', fields: [f('full_name', 'Full name'), f('passport_number', 'Passport number'), f('nationality', 'Nationality'), f('date_of_birth', 'Date of birth', 'date'), f('expiry_date', 'Expiry date', 'date')] },
  safety: { label: 'Safety certificate', fields: [f('issuing_authority', 'Issuing authority'), f('certificate_number', 'Certificate number'), f('boat_name', 'Boat name'), f('issue_date', 'Issue date', 'date'), f('expiry_date', 'Expiry date', 'date')] },
};

// Without an expiry these never count as met; the rest: null = no expiry.
const EXPIRY_REQUIRED = ['insurance', 'acord25', 'passport'];

module.exports = { TYPES, TYPE_NAMES: Object.keys(TYPES), EXPIRY_REQUIRED };
