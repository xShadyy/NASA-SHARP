"""Offline regression cases from the audited data paths; no NASA quota consumed."""
import asyncio
import json
import os
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ['SHARP_GLOBAL_INGEST_ENABLED'] = '0'
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
import app as api
from global_store import GlobalStore
from global_ingestion import parse_bulk
from harmonize import CanonicalStore, Coverage, Detection, detection_id, evaluate_query
from observation_explorer import cached_snapshot, remember_snapshot, freeze_document, observations_document, export_document, scoped_snapshot, freshness_metadata, SelectionInvalid
from quota import QuotaGovernor, QuotaUnavailable, governed_csv, reconcile_provider
from global_tiles import GlobalPresentation

AREA = {'type':'Polygon','coordinates': [[[0,0],[20,0],[20,60],[0,60],[0,0]]]}
ANCHOR = datetime(2026,11,15,13,tzinfo=UTC)

def query(start='2026-11-08', end='2026-11-09'):
    return {'id':'audited-scope','processingMode':'harmonized','aoi':{'geometry':AREA},'interval':{'start':start+'T00:00:00Z','endExclusive':end+'T00:00:00Z'},'filters':{'platforms':['aqua'],'dayNight':'all','modisConfidenceMin':0,'viirsConfidence':['low','nominal','high']}}

def row(day=8,hour=6,lon=12):
    return Detection('aqua',52,lon,datetime(2026,11,day,hour,tzinfo=UTC),12,None,75,'D',1,1,1000,'MODIS_NRT','6.1NRT','NRT')

async def content(response):
    parts=[]
    async for part in response.body_iterator: parts.append(part.decode() if isinstance(part,bytes) else part)
    return ''.join(parts)

class AuditDataTests(unittest.TestCase):
    def setUp(self):
        self.directory=tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.store=GlobalStore(Path(self.directory.name)/'global.sqlite')

    def test_all_bulk_provider_schemas_and_native_confidence_encodings(self):
        fixtures=Path(__file__).parent/'fixtures'
        for provider,file in [('MODIS_NRT','firms_modis_bulk.csv'),('VIIRS_NOAA20_NRT','firms_noaa20_bulk.csv'),('VIIRS_NOAA21_NRT','firms_noaa21_bulk.csv')]:
            rows=tuple(parse_bulk((fixtures/file).read_text(encoding='utf-8'),provider))
            self.assertTrue(rows)
            self.assertTrue(all(item.source_product==provider for item in rows))
            self.assertTrue(all(item.processing_tier=='NRT' for item in rows))
            if provider=='VIIRS_NOAA20_NRT':
                self.assertEqual([item.confidence_class for item in rows],['low','nominal','high'])
                self.assertEqual([item.confidence_native for item in rows],['low','nominal','high'])
        text=(fixtures/'firms_noaa20_bulk.csv').read_text(encoding='utf-8').replace(',nominal,',',invalid,')
        with self.assertRaises(api.FIRMSFailure): tuple(parse_bulk(text,'VIIRS_NOAA20_NRT'))

    def test_full_source_day_is_not_cropped_by_rolling_seven_day_display(self):
        rows=[row(hour=6),row(hour=18)]
        self.store.replace_source('MODIS_NRT',rows,datetime(2026,11,8,tzinfo=UTC),ANCHOR,retrieved=ANCHOR.timestamp())
        manifest=self.store.publish(ANCHOR,['MODIS_NRT'],ANCHOR.timestamp())
        self.assertEqual(len(tuple(self.store.iter_observations(manifest['snapshot'],'7d'))),1)
        application=SimpleNamespace(state=SimpleNamespace(global_store=self.store))
        batch=api.global_source_batch(application,api.Source.MODIS_NRT,'world',date(2026,11,8))
        self.assertEqual(len(batch[0]),2)
        self.assertEqual(batch[0].coverage_state,'complete')
        selected=api.stored_global_aoi(application,query(),(0,0,20,60))
        self.assertEqual({item.acquired_at.hour for item in selected.rows},{6,18})

    def test_aoi_budget_counts_only_selected_interval_before_materialization(self):
        rows=[row(day=day,lon=12+index*.000001) for day in range(9,15) for index in range(8)] + [row(day=8)]
        self.store.replace_source('MODIS_NRT',rows,datetime(2026,11,8,tzinfo=UTC),ANCHOR,retrieved=ANCHOR.timestamp())
        self.store.publish(ANCHOR,['MODIS_NRT'],ANCHOR.timestamp())
        application=SimpleNamespace(state=SimpleNamespace(global_store=self.store))
        with patch.object(api,'MAX_CANONICAL_ACQUISITION_ROWS',2):
            selected=api.stored_global_aoi(application,query(),(0,0,20,60))
        self.assertEqual(len(selected.rows),1)

    def test_exact_polygon_membership_precedes_aoi_retention_budget(self):
        rows=[replace(row(),latitude=1,longitude=1),*[replace(row(),latitude=59,longitude=19+index*.0001) for index in range(5)]]
        self.store.replace_source('MODIS_NRT',rows,datetime(2026,11,8,tzinfo=UTC),ANCHOR,retrieved=ANCHOR.timestamp())
        self.store.publish(ANCHOR,['MODIS_NRT'],ANCHOR.timestamp())
        requested=query(); requested['aoi']['geometry']={'type':'Polygon','coordinates':[[[0,0],[20,0],[0,60],[0,0]]]}
        application=SimpleNamespace(state=SimpleNamespace(global_store=self.store))
        with patch.object(api,'MAX_CANONICAL_ACQUISITION_ROWS',2):
            selected=api.stored_global_aoi(application,requested,(0,0,20,60))
        self.assertEqual(len(selected.rows),1)

    def test_large_archive_small_investigation_retains_records_selection_and_complete_export(self):
        selected=row(day=8)
        unrelated=tuple(replace(selected,longitude=100+index*.0000001) for index in range(200001))
        archive=CanonicalStore((selected,*unrelated),(Coverage(date(2026,11,8),'aqua','complete'),),'large archive',coverage_geometry={'type':'Polygon','coordinates':[[[-180,-90],[180,-90],[180,90],[-180,90],[-180,-90]]]},generation='archive-generation-1')
        requested=query(); remember_snapshot(requested,archive)
        scoped=cached_snapshot(requested,{})
        self.assertEqual(len(scoped.rows),1)
        token=freeze_document(requested,scoped,{'options':{'observationIds':[detection_id(selected)]}})['data']['selectionToken']
        page=observations_document(requested,cached_snapshot(requested,{'selectionToken':token}),{'options':{'selectionToken':token,'search':'aqua','pageSize':1}})
        self.assertEqual(page['data']['total'],1)
        exported=export_document(requested,scoped,{'format':'json','options':{'selectionToken':token}})
        self.assertEqual(len(json.loads(asyncio.run(content(exported)))['observations']),1)

    def test_scoped_retention_preserves_full_regional_calibration(self):
        requested=query(); requested['filters']['platforms']=['aqua','noaa-20']
        rows=[row(day=8)]; coverage=[Coverage(date(2026,11,8),'aqua','complete')]
        for day in range(9,23):
            aqua=row(day=day)
            rows.extend([aqua,replace(aqua,platform='noaa-20',confidence_pct=None,confidence_class='high'),replace(aqua,platform='noaa-20',longitude=13,confidence_pct=None,confidence_class='high')])
            coverage.extend([Coverage(date(2026,11,day),'aqua','complete'),Coverage(date(2026,11,day),'noaa-20','complete')])
        archive=CanonicalStore(tuple(rows),tuple(coverage),'full regional overlap',coverage_geometry=AREA)
        before=evaluate_query(requested,archive)[0]
        scoped=scoped_snapshot(requested,archive)
        after=evaluate_query(requested,scoped)[0]
        self.assertEqual(before.scale,2)
        self.assertEqual(after.days,before.days)
        self.assertEqual(after.overlap_days,14)
        self.assertEqual(len(scoped.rows),1)

    def test_generation_guards_and_complete_investigation_export(self):
        requested=query(); stored=CanonicalStore((replace(row(),confidence_native='75'),),(Coverage(date(2026,11,8),'aqua','complete'),),'export source',generation='frozen-generation')
        investigation={'version':1,'area':{'id':'selected','name':'Selected region'},'focusedDay':'2026-11-08','selection':{'sourceGeneration':'frozen-generation','observationIds':['oversized-browser-list']},'method':'afternoon-active-cells-2km-1'}
        for build in (observations_document,export_document):
            with self.assertRaises(SelectionInvalid): build(requested,stored,{'options':{'sourceGeneration':'newer-generation'}})
        exported=json.loads(asyncio.run(content(export_document(requested,stored,{'format':'json','investigation':investigation,'options':{'sourceGeneration':'frozen-generation'}}))))
        self.assertEqual(exported['reproducibility']['investigation']['focusedDay'],'2026-11-08')
        self.assertNotIn('observationIds',exported['reproducibility']['investigation']['selection'])
        csv_text=asyncio.run(content(export_document(requested,stored,{'format':'csv'})))
        self.assertIn('confidenceNativeValue',csv_text.splitlines()[0])

    def test_historical_day_navigation_and_whole_period_records_reuse_exact_archive_generation(self):
        from fastapi.testclient import TestClient
        from test_historical_activity import archive, query as historical_query
        manifest, original=archive()
        stored=replace(original,generation=manifest['generation'],coverage_geometry=manifest['geometry'],source='Regional archive '+manifest['datasetVersion'])
        day=historical_query('2024-01-01','2024-01-02')
        remember_snapshot(day,stored)
        selected=next(row for row in stored.rows if row.acquired_at.date()==date(2024,1,1))
        token=freeze_document(day,stored,{'options':{'observationIds':[detection_id(selected)]}})['data']['selectionToken']
        next_day=historical_query('2024-01-02','2024-01-03')
        whole=historical_query('2024-01-01','2024-04-01')
        options={'sourceGeneration':manifest['generation']}
        with patch.dict(os.environ,{'FIRMS_MAP_KEY':'','SHARP_GLOBAL_INGEST_ENABLED':'0','SHARP_GLOBAL_DB_PATH':str(self.store.path)}), patch('scientific_routes.load_archive',return_value=(manifest,stored)) as loaded, patch.object(api,'shared_firms_store',side_effect=AssertionError('Historical navigation must not acquire NASA data')), TestClient(api.app) as client:
            focused=client.post('/analysis/observations',json={'query':next_day,'options':options})
            self.assertEqual(focused.status_code,200,focused.text)
            self.assertEqual(focused.json()['data']['total'],1)
            self.assertEqual(focused.json()['meta']['sourceGeneration'],manifest['generation'])
            complete=client.post('/analysis/observations',json={'query':whole,'options':{**options,'pageSize':25}})
            self.assertEqual(complete.status_code,200,complete.text)
            expected=sum(date(2024,1,1)<=row.acquired_at.date()<date(2024,4,1) for row in stored.rows)
            self.assertGreater(expected,31)
            self.assertEqual(complete.json()['data']['total'],expected)
            exported=client.post('/analysis/observations/export',json={'query':whole,'format':'json','options':options})
            self.assertEqual(exported.status_code,200,exported.text)
            self.assertEqual(len(exported.json()['observations']),expected)
            self.assertEqual(client.post('/analysis/observations',json={'query':next_day,'options':{'sourceGeneration':'wrong-generation'}}).status_code,409)
            loaded.reset_mock()
            self.assertEqual(client.post('/analysis/observations',json={'query':next_day,'options':{'selectionToken':'expired-token','sourceGeneration':manifest['generation']}}).status_code,409)
            loaded.assert_not_called()
            # A token for the original focused day cannot silently become another day's group.
            self.assertEqual(client.post('/analysis/observations',json={'query':next_day,'options':{**options,'selectionToken':token}}).status_code,409)

    def test_failed_source_keeps_old_retrieval_and_conservative_analytical_expiry(self):
        old=ANCHOR.timestamp()-7200
        self.store.replace_source('MODIS_NRT',[row(day=14)],ANCHOR-timedelta(days=7),ANCHOR,retrieved=old)
        self.store.record_failure('MODIS_NRT','Provider timeout',ANCHOR.timestamp())
        self.store.replace_source('VIIRS_NOAA20_NRT',[],ANCHOR-timedelta(days=7),ANCHOR,retrieved=ANCHOR.timestamp())
        published=self.store.publish(ANCHOR,['MODIS_NRT','VIIRS_NOAA20_NRT'],ANCHOR.timestamp())
        result=self.store.canonical_store(published['snapshot'],'24h')
        self.assertEqual(result.fetched_at,old)
        self.assertLessEqual(result.expires_at,ANCHOR.timestamp())
        self.assertEqual(len(result.source_states),2)
        self.assertEqual(result.source_states[0]['failure'],'Provider timeout')
        self.assertEqual(freshness_metadata(result,ANCHOR.timestamp())['freshness'],'mixed')

    def test_cold_keyed_calls_await_shared_status_check_before_reserving(self):
        async def exercise():
            path=Path(self.directory.name)/'quota.sqlite'; ready=asyncio.Event(); statuses=[]; calls=[]
            async def transport(request):
                statuses.append(request.url.path); await asyncio.sleep(.08); ready.set()
                return httpx.Response(200,json={'current_transactions':0,'transaction_limit':5000})
            async with httpx.AsyncClient(base_url='https://firms.modaps.eosdis.nasa.gov',transport=httpx.MockTransport(transport)) as client:
                async def raw(_app,_path,_started):
                    self.assertTrue(ready.is_set()); calls.append(1)
                    return 'latitude,longitude,acq_date\n52,12,2026-11-14\n'
                applications=[SimpleNamespace(state=SimpleNamespace(quota=QuotaGovernor(path,'test-only-key'),firms=client,key='test-only-key')) for _ in range(8)]
                values=await asyncio.gather(*(governed_csv(application,'/api/area/csv/test-only-key/MODIS_NRT/1,1,2,2/1',None,raw) for application in applications))
                self.assertEqual(len(values),8); self.assertEqual(len(statuses),1); self.assertEqual(len(calls),8)
        asyncio.run(exercise())

    def test_quota_status_rate_limit_preserves_retry_after_for_all_waiters(self):
        async def exercise():
            path=Path(self.directory.name)/'quota-status.sqlite'
            async with httpx.AsyncClient(base_url='https://firms.modaps.eosdis.nasa.gov',transport=httpx.MockTransport(lambda _:httpx.Response(429,headers={'Retry-After':'1800'}))) as client:
                governor=QuotaGovernor(path,'test-only-key')
                application=SimpleNamespace(state=SimpleNamespace(quota=governor,firms=client,key='test-only-key'))
                with self.assertRaises(QuotaUnavailable) as failure:
                    await reconcile_provider(application,governor)
                self.assertEqual(failure.exception.retry_after,1800)
                self.assertGreater(governor.status()['blockedUntil'],__import__('time').time()+1700)
                with self.assertRaises(QuotaUnavailable):
                    await reconcile_provider(application,QuotaGovernor(path,'test-only-key'))
        asyncio.run(exercise())

    def test_global_frozen_map_restriction_and_analytics_counts_match(self):
        rows=[row(day=15,hour=6,lon=12+index*.0001) for index in range(5)] + [row(day=15,hour=7,lon=80)]
        self.store.replace_source('MODIS_NRT',rows,ANCHOR-timedelta(days=7),ANCHOR,retrieved=ANCHOR.timestamp())
        snapshot=self.store.publish(ANCHOR,['MODIS_NRT'])['snapshot']; service=GlobalPresentation(self.store)
        world=json.loads(service.tile(snapshot,'24h',0,0,0)[0]); group=next(feature['properties']['aggregateId'] for feature in world['features'] if feature['properties'].get('count')==5)
        filtered=json.loads(service.tile(snapshot,'24h',0,0,0,{'acquisitionHour':6},group)[0])
        self.assertEqual(filtered['count'],5)
        for feature in filtered['features']:
            if feature['properties'].get('aggregateId'):
                data=service.observations(snapshot,'24h',feature['properties']['aggregateId'])['data']
                self.assertEqual(data['total'],5)
                self.assertEqual(data['summary']['statistics']['frpReported'],5)
                self.assertEqual(data['summary']['statistics']['medianFrp'],12)

if __name__=='__main__': unittest.main()
