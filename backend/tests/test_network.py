import unittest
from unittest.mock import Mock
from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from channel_backend.network import public_origin, access_policy, validate_device_config
from channel_backend.server import create_app


class NetworkTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.cfg={"port":8660,"public_url":"https://bot.company.example","backend_id":"backend_"+"1"*32}
        self.app=create_app(self.cfg,Mock(),Mock(),start_worker=False)

    async def request(self,headers,remote="127.0.0.1"):
        req=make_mocked_request("GET","/health",headers=headers,app=self.app)
        req._cache["remote"]=remote
        async def handler(_):return web.Response(text="passed")
        return await self.app.middlewares[0](req,handler)

    async def test_only_configured_domain_https_and_trusted_proxy(self):
        good={"Host":"bot.company.example","X-Forwarded-Proto":"https","Origin":"https://bot.company.example"}
        self.assertEqual((await self.request(good)).status,200)
        for changes in ({"Host":"evil.example"},{"Origin":"https://evil.example"},{"Origin":"http://bot.company.example"},{"X-Forwarded-Proto":"http"},{"X-Forwarded-Proto":"https, http"}):
            self.assertEqual((await self.request({**good,**changes})).status,403)
        self.assertEqual((await self.request(good,remote="172.30.87.9")).status,403)
        self.assertEqual((await self.request({"Host":"evil.example","X-Forwarded-Host":"bot.company.example","X-Forwarded-Proto":"https"})).status,403)
        self.assertEqual((await self.request({"Host":"bot.company.example"})).status,403)

    async def test_loopback_still_valid_for_health_and_usb(self):
        self.assertEqual((await self.request({"Host":"127.0.0.1:8660"},remote="127.0.0.1")).status,200)
        self.assertEqual((await self.request({"Host":"localhost:8660","Origin":"http://localhost:8660"},remote="127.0.0.1")).status,200)

    def test_origin_validation_and_required_backend_identity(self):
        for url in ("https://bot.company.example","https://bot.company.example:8443","https://xn--test-9za.example"):
            self.assertEqual(public_origin(url),url)
        for url in ("http://bot.company.example","https://user:pass@bot.company.example","https://bot.company.example/path","https://bot.company.example/","https://bot.company.example?q=1","https://bot.company.example#key=x","https://127.0.0.1","https://[::1]","https://a..example","https://-x.example","https://x-.example","https://a.example:65536","https://a.example:0","https://a.example:0443","https://a.example\\evil","HTTPS://a.example",None):
            with self.assertRaises(ValueError,msg=str(url)):public_origin(url)
        for cfg in ({**self.cfg,"backend_id":""},):
            with self.assertRaises(ValueError):access_policy(cfg)

    def test_device_export_requires_unique_backend_and_test_group(self):
        config={"version":1,"baseUrl":self.cfg["public_url"],"backendId":self.cfg["backend_id"],"deviceId":"phone","deviceKey":"d"*40,"groupRef":"test-1","groupName":"测试1"}
        self.assertEqual(validate_device_config(config),config)
        for extra in ({"backendId":""},{"baseUrl":"http://10.0.0.1:8660"},{"groupName":"其他群"},{"deviceKey":"short"},{"reviewKey":"must-not-export"}):
            with self.assertRaises(ValueError):validate_device_config({**config,**extra})
        legacy={**config,"baseUrl":"http://127.0.0.1:8660"};del legacy["backendId"]
        self.assertEqual(validate_device_config(legacy),legacy)
