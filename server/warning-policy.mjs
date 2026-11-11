export function warningAuthorization(args, mode, session) {
  const warningPolicy=args.warningPolicy??'rollback';
  if(!['rollback','allow_warnings'].includes(warningPolicy))throw new Error('Unknown warningPolicy');
  if(warningPolicy==='rollback')return {};
  if(mode==='query'||mode==='none')throw new Error('Read-only queries cannot authorize warnings');
  if(!session.capabilities?.authorizedWarningPolicy)throw new Error('User-authorized warnings require bridge 0.7.0 after Revit restart');
  if(typeof args.warningApproval!=='string'||!args.warningApproval.trim()||args.warningApproval.length>2000)throw new Error('Explicit warningApproval text is required (1..2000 characters)');
  return {warningPolicy,warningApproval:args.warningApproval};
}
