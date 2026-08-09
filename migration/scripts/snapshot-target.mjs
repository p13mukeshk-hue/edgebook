#!/usr/bin/env node
import { lstat, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import pg from 'pg';
import { appendNdjson, openNdjson, parseArgs, resolveContainedRegularFile, sha256File } from '../lib/bundle.mjs';

const args=parseArgs(process.argv.slice(2));
if(!args.output||!isAbsolute(args.output)||!args['upload-root']||!isAbsolute(args['upload-root'])){
  process.stderr.write('Usage: TARGET_DATABASE_URL=... node scripts/snapshot-target.mjs --upload-root /srv/edgebook-data/uploads --output /absolute/new.ndjson\n');
  process.exit(2);
}
if(!process.env.TARGET_DATABASE_URL) throw new Error('TARGET_DATABASE_URL is required');
const output=resolve(args.output); const requestedUploadRoot=resolve(args['upload-root']);
const uploadRoot=await realpath(requestedUploadRoot);
const uploadRootInfo=await lstat(uploadRoot);
if(uploadRoot!==requestedUploadRoot||uploadRootInfo.isSymbolicLink()||!uploadRootInfo.isDirectory()) {
  throw new Error('upload-root must be a real directory whose path does not resolve through a symlink');
}
const outputRelative=relative(uploadRoot,output);
if(outputRelative===''||(!outputRelative.startsWith(`..${sep}`)&&outputRelative!=='..')) throw new Error('snapshot output must be outside the private upload root');
const handle=await openNdjson(output);
const client=new pg.Client({connectionString:process.env.TARGET_DATABASE_URL});
await client.connect(); const counts={trades:0,screenshotFiles:0,rawDocuments:0,materializedDocuments:0,identities:0,settings:0,accounts:0,brokers:0,moods:0,journals:0};
let snapshotComplete=false;
try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const rows=await client.query(`SELECT u.legacy_firebase_uid,t.legacy_firebase_doc_id,t.legacy_document,
    t.external_trade_key,t.broker_trade_id,t.symbol,t.asset,t.instrument,t.option_type,t.strike,t.expiry,
    t.exchange,t.product,t.trade_date,t.entry_price,t.exit_price,t.quantity,t.pnl,t.stop_loss,t.take_profit,
    t.direction,t.is_open,t.legacy_entry_time,t.legacy_exit_time,t.strategy,t.emotion,t.notes,t.tags,
    t.psychology,t.custom_fields,t.broker_data,t.deleted_at,t.source_system,t.ingestion_method,
    t.legacy_account_id,a.legacy_account_id AS linked_legacy_account_id,
    b.legacy_firebase_doc_id AS broker_legacy_document_id,
    COALESCE(jsonb_agg(jsonb_build_object('name',f.original_name,'sha256',encode(f.sha256,'hex'),'storageKey',f.storage_key) ORDER BY f.created_at,f.id)
      FILTER (WHERE f.id IS NOT NULL),'[]'::jsonb) AS files
    FROM trades t JOIN users u ON u.id=t.user_id
    LEFT JOIN accounts a ON a.id=t.account_id AND a.user_id=t.user_id
    LEFT JOIN broker_connections b ON b.id=t.broker_connection_id AND b.user_id=t.user_id
    LEFT JOIN file_objects f ON f.trade_id=t.id AND f.deleted_at IS NULL
    WHERE u.legacy_firebase_uid IS NOT NULL AND t.legacy_firebase_doc_id IS NOT NULL
    GROUP BY u.legacy_firebase_uid,t.id,a.legacy_account_id,b.legacy_firebase_doc_id
    ORDER BY u.legacy_firebase_uid,t.legacy_firebase_doc_id`);
  for(const row of rows.rows){
    const files=[];
    for(const file of row.files){
      const filePath=await resolveContainedRegularFile(uploadRoot,file.storageKey);
      const actualSha256=await sha256File(filePath);
      if(actualSha256!==file.sha256) throw new Error(`private screenshot checksum mismatch: ${file.storageKey}`);
      files.push({name:file.name,sha256:actualSha256}); counts.screenshotFiles+=1;
    }
    // Promoted live rows intentionally clear legacy screenshot URLs. Rebuild
    // the neutral source shape from the canonical private file inventory.
    const canonicalScreenshots=row.files.map((file)=>({name:file.name||null}));
    const numeric=value=>value===null?null:Number(value);
    const data={...row.legacy_document,
      source:row.source_system,sourceSystem:row.source_system,ingestionMethod:row.ingestion_method,
      accountId:row.legacy_account_id,externalTradeKey:row.external_trade_key,brokerTradeId:row.broker_trade_id,
      symbol:row.symbol,asset:row.asset,instrument:row.instrument,optionType:row.option_type,strike:numeric(row.strike),
      expiry:row.expiry===null?null:String(row.expiry).slice(0,10),exchange:row.exchange,product:row.product,
      date:String(row.trade_date).slice(0,10),entry:Number(row.entry_price),exit:numeric(row.exit_price),
      size:Number(row.quantity),pnl:numeric(row.pnl),sl:numeric(row.stop_loss),tp:numeric(row.take_profit),
      direction:row.direction,isOpen:row.is_open,
      entryTime:row.legacy_entry_time?.slice(0,8)??null,exitTime:row.legacy_exit_time?.slice(0,8)??null,
      strategy:row.strategy,emotion:row.emotion,notes:row.notes,tags:row.tags,psychology:row.psychology,
      custom:row.custom_fields,brokerData:row.broker_data,
      needsReview:row.broker_data?.needsReview??null,groupingMode:row.broker_data?.groupingMode??null,
      lotSize:numeric(row.broker_data?.lotSize??null),deleted:row.deleted_at!==null,
      deletedAt:row.deleted_at===null?null:new Date(row.deleted_at).toISOString(),
      screenshots:canonicalScreenshots};
    await appendNdjson(handle,{recordType:'trade',legacyPath:`users/${row.legacy_firebase_uid}/trades/${row.legacy_firebase_doc_id}`,data,
      mapped:{sourceSystem:row.source_system,ingestionMethod:row.ingestion_method,
        legacyAccountId:row.legacy_account_id,linkedLegacyAccountId:row.linked_legacy_account_id,
        legacyBrokerDocumentId:row.broker_legacy_document_id,files}}); counts.trades+=1;
  }
  const archives=await client.query(`SELECT source_path,payload_sha256 FROM legacy_firebase_documents ORDER BY source_path`);
  for(const row of archives.rows){
    await appendNdjson(handle,{recordType:'rawDocument',sourcePath:row.source_path,payloadSha256:row.payload_sha256});
    counts.rawDocuments+=1;
  }
  const materialized=await client.query(`
    SELECT 'users/'||u.legacy_firebase_uid||'/notifications/'||n.legacy_firebase_doc_id AS source_path
      FROM notifications n JOIN users u ON u.id=n.user_id
      WHERE u.legacy_firebase_uid IS NOT NULL AND n.legacy_firebase_doc_id IS NOT NULL
    UNION ALL
    SELECT 'users/'||u.legacy_firebase_uid||'/orders/'||o.legacy_firebase_doc_id
      FROM broker_orders o JOIN users u ON u.id=o.user_id
      WHERE u.legacy_firebase_uid IS NOT NULL AND o.legacy_firebase_doc_id IS NOT NULL
    UNION ALL
    SELECT 'users/'||u.legacy_firebase_uid||'/pendingDuplicates/'||d.legacy_firebase_doc_id
      FROM pending_duplicates d JOIN users u ON u.id=d.user_id
      WHERE u.legacy_firebase_uid IS NOT NULL AND d.legacy_firebase_doc_id IS NOT NULL
    ORDER BY source_path`);
  for(const row of materialized.rows){
    await appendNdjson(handle,{recordType:'materializedDocument',sourcePath:row.source_path});
    counts.materializedDocuments+=1;
  }
  const identities=await client.query(`SELECT legacy_firebase_uid,google_sub FROM users
    WHERE legacy_firebase_uid IS NOT NULL ORDER BY legacy_firebase_uid`);
  for(const row of identities.rows){
    await appendNdjson(handle,{recordType:'identity',firebaseUid:row.legacy_firebase_uid,googleSub:row.google_sub});
    counts.identities+=1;
  }
  const settings=await client.query(`SELECT u.legacy_firebase_uid,s.settings FROM user_settings s
    JOIN users u ON u.id=s.user_id WHERE u.legacy_firebase_uid IS NOT NULL ORDER BY u.legacy_firebase_uid`);
  for(const row of settings.rows){
    await appendNdjson(handle,{recordType:'settings',firebaseUid:row.legacy_firebase_uid,data:row.settings}); counts.settings+=1;
  }
  const accounts=await client.query(`SELECT u.legacy_firebase_uid,a.legacy_account_id,a.metadata FROM accounts a
    JOIN users u ON u.id=a.user_id WHERE u.legacy_firebase_uid IS NOT NULL AND a.legacy_account_id IS NOT NULL
    ORDER BY u.legacy_firebase_uid,a.legacy_account_id`);
  for(const row of accounts.rows){
    await appendNdjson(handle,{recordType:'account',firebaseUid:row.legacy_firebase_uid,
      legacyAccountId:row.legacy_account_id,data:row.metadata}); counts.accounts+=1;
  }
  const brokers=await client.query(`SELECT u.legacy_firebase_uid,b.legacy_firebase_doc_id,b.provider,
    b.external_account_id,b.account_label,a.legacy_account_id AS mapped_legacy_account_id,b.connected,
    b.access_token_ciphertext,b.refresh_token_ciphertext,b.provider_metadata
    FROM broker_connections b JOIN users u ON u.id=b.user_id
    LEFT JOIN accounts a ON a.id=b.mapped_account_id AND a.user_id=b.user_id
    WHERE u.legacy_firebase_uid IS NOT NULL AND b.legacy_firebase_doc_id IS NOT NULL
    ORDER BY u.legacy_firebase_uid,b.legacy_firebase_doc_id`);
  for(const row of brokers.rows){
    await appendNdjson(handle,{recordType:'broker',firebaseUid:row.legacy_firebase_uid,
      legacyDocumentId:row.legacy_firebase_doc_id,data:{provider:row.provider,
        externalAccountId:row.external_account_id,accountLabel:row.account_label,
        mappedLegacyAccountId:row.mapped_legacy_account_id,connected:row.connected,
        credentialsPresent:row.access_token_ciphertext!==null||row.refresh_token_ciphertext!==null,
        metadata:row.provider_metadata}}); counts.brokers+=1;
  }
  const moods=await client.query(`SELECT u.legacy_firebase_uid,m.legacy_id,m.metadata FROM mood_checkins m
    JOIN users u ON u.id=m.user_id WHERE u.legacy_firebase_uid IS NOT NULL AND m.legacy_id IS NOT NULL
    ORDER BY u.legacy_firebase_uid,m.legacy_id`);
  for(const row of moods.rows){
    await appendNdjson(handle,{recordType:'mood',firebaseUid:row.legacy_firebase_uid,legacyId:row.legacy_id,data:row.metadata}); counts.moods+=1;
  }
  const journals=await client.query(`SELECT u.legacy_firebase_uid,j.journal_date,j.legacy_document
    FROM daily_journal_entries j JOIN users u ON u.id=j.user_id WHERE u.legacy_firebase_uid IS NOT NULL
    ORDER BY u.legacy_firebase_uid,j.journal_date`);
  for(const row of journals.rows){
    await appendNdjson(handle,{recordType:'journal',firebaseUid:row.legacy_firebase_uid,
      date:String(row.journal_date).slice(0,10),data:row.legacy_document}); counts.journals+=1;
  }
  await client.query('COMMIT');
  await handle.close();
  snapshotComplete=true;
}catch(error){
  await client.query('ROLLBACK').catch(()=>{});
  await handle.close().catch(()=>{});
  throw error;
}finally{
  await client.end();
  if(!snapshotComplete) await unlink(output).catch(()=>{});
}
process.stdout.write(`${JSON.stringify({output,counts,sha256:await sha256File(output)},null,2)}\n`);
