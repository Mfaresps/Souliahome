import { EventEmitter } from 'events';
import { SettingsController } from '../../src/settings/settings.controller';
const https = require('https');

describe('Bosta connection check',()=>{
  let controller:SettingsController,request:jest.SpyInstance;
  beforeEach(()=>{controller=Object.create(SettingsController.prototype);(controller as any).settingsService={getBostaApiKey:async()=>'fixture-carrier-key'};});
  afterEach(()=>jest.restoreAllMocks());
  function response(statusCode:number){
    request=jest.spyOn(https,'request').mockImplementation((options:any,callback:any)=>{
      expect(options.path).toBe('/api/v2/pickup-locations');expect(options.method).toBe('GET');
      const req:any=new EventEmitter();req.end=()=>{const res:any=new EventEmitter();res.statusCode=statusCode;callback(res);res.emit('end');};return req;
    });
  }
  it('checks a read-only carrier route using the saved key',async()=>{
    response(200);expect(await controller.testBostaApiKey('')).toMatchObject({success:true,state:'connected'});
    expect(request.mock.calls[0][0].headers.Authorization).toBe('fixture-carrier-key');
  });
  it('reports an authorization failure separately from a failed check',async()=>{
    response(401);expect(await controller.testBostaApiKey('')).toMatchObject({success:false,state:'disconnected'});
  });
  it('does not call an unavailable endpoint a disconnected integration',async()=>{
    response(503);expect(await controller.testBostaApiKey('')).toMatchObject({success:false,state:'error'});
  });
  it('reports network failures without declaring the key invalid',async()=>{
    jest.spyOn(https,'request').mockImplementation(()=>{const req:any=new EventEmitter();req.end=()=>req.emit('error',new Error('network unavailable'));return req;});
    expect(await controller.testBostaApiKey('')).toMatchObject({success:false,state:'error'});
  });
});
