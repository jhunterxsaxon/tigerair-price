# -*- coding: utf-8 -*-
"""站碼 ↔ 中文站名對照，以及城市群組（MAC）代碼的處理。

為什麼需要這支：
    票價 API 只回代碼（TPE、OKA、XX7…），畫面上要顯示看得懂的名字。
    其中 **XX 開頭的是「城市群組代碼」**（例如 XX7 代表東京地區，涵蓋成田與羽田兩個機場），
    使用者要求保留這些群組，但一定要標示清楚是哪個城市。

資料來源：
    官網的 GraphQL（stationsForStationList）回傳 code／title／stationMacCode，
    探測時已抓下來存成 data/stations.json。群組名稱官方沒給中文，
    所以這裡用「成員站名」自動組出可讀的標示，例如：
        XX7 → 「東京地區（東京成田/東京羽田）」
"""
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(_HERE), "data", "stations.json")

# 群組代碼的人工命名（依成員推得；沒列到的會自動用成員站名組字）
MAC_NAMES = {
    "XX2": "北海道地區", "XX3": "台灣", "XX4": "韓國", "XX5": "日本東北地區",
    "XX6": "日本中部地區", "XX7": "東京地區", "XX8": "關西・山陽地區",
    "XX9": "九州地區", "XXO": "沖繩地區", "XXT": "泰國", "XXV": "越南",
}
COUNTRY_NAMES = {"TW": "台灣", "JP": "日本", "KR": "南韓", "TH": "泰國", "VN": "越南"}

# 讀不到 data/stations.json 時的備援（2026-10-29 自官網取得）
_FALLBACK = [
    ("TPE", "台北(桃園)", "TW", "XX3"), ("RMQ", "台中", "TW", "XX3"),
    ("KHH", "高雄", "TW", "XX3"), ("TNN", "台南", "TW", "XX3"),
    ("NRT", "東京成田", "JP", "XX7"), ("HND", "東京羽田", "JP", "XX7"),
    ("KIX", "大阪", "JP", "XX8"), ("OKJ", "岡山", "JP", "XX8"),
    ("YGJ", "米子", "JP", "XX8"), ("KCZ", "高知", "JP", "XX8"),
    ("FUK", "福岡", "JP", "XX9"), ("HSG", "佐賀", "JP", "XX9"),
    ("KMI", "宮崎", "JP", "XX9"), ("KMJ", "熊本", "JP", "XX9"),
    ("OIT", "大分", "JP", "XX9"), ("CTS", "札幌(新千歲)", "JP", "XX2"),
    ("HKD", "函館", "JP", "XX2"), ("SDJ", "仙台", "JP", "XX5"),
    ("AXT", "秋田", "JP", "XX5"), ("FKS", "福島", "JP", "XX5"),
    ("HNA", "花卷", "JP", "XX5"), ("KIJ", "新潟", "JP", "XX5"),
    ("NGO", "名古屋", "JP", "XX6"), ("KMQ", "小松", "JP", "XX6"),
    ("OKA", "沖繩", "JP", "XXO"), ("ISG", "石垣島", "JP", "XXO"),
    ("ICN", "首爾(仁川)", "KR", "XX4"), ("GMP", "首爾(金浦)", "KR", "XX4"),
    ("PUS", "釜山", "KR", "XX4"), ("CJU", "濟州", "KR", "XX4"),
    ("DAD", "峴港", "VN", "XXV"), ("HKT", "普吉島", "TH", "XXT"),
]


class Stations:
    def __init__(self, path=DATA):
        self.by_code = {}          # 站碼 → {code, name, country, mac}
        self.mac_members = {}      # 群組代碼 → [站碼, ...]
        self._load(path)

    def _load(self, path):
        rows = []
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            for s in data.get("stations", []):
                if s.get("code"):
                    rows.append((s["code"], s.get("name") or s["code"],
                                 s.get("country") or "", s.get("mac") or ""))
        except (OSError, ValueError):
            rows = []
        if not rows:
            rows = list(_FALLBACK)
        for code, name, country, mac in rows:
            self.by_code[code] = {"code": code, "name": name,
                                  "country": country, "mac": mac}
            if mac:
                self.mac_members.setdefault(mac, []).append(code)

    # ---------- 名稱 ----------
    def name(self, code):
        """站碼 → 中文名；群組代碼回群組名；都查不到就回代碼本身。"""
        if code in self.by_code:
            return self.by_code[code]["name"]
        if self.is_mac(code):
            return MAC_NAMES.get(code) or self._auto_mac_name(code)
        return code

    def _auto_mac_name(self, mac):
        names = [self.by_code[c]["name"] for c in self.mac_members.get(mac, [])]
        return ("／".join(names) + " 地區") if names else mac

    def label(self, code):
        """畫面顯示用：
        一般站 → 「東京成田 (NRT)」
        群組   → 「東京地區 (XX7：東京成田/東京羽田)」 ← 使用者要求一定要標示是哪些城市
        """
        if self.is_mac(code):
            members = "/".join(self.by_code[c]["name"]
                               for c in self.mac_members.get(code, []))
            base = MAC_NAMES.get(code) or self._auto_mac_name(code)
            return f"{base} ({code}：{members})" if members else f"{base} ({code})"
        info = self.by_code.get(code)
        return f"{info['name']} ({code})" if info else code

    def route_label(self, origin, destination):
        """航線顯示：「台北(桃園) (TPE) → 沖繩 (OKA)」"""
        return f"{self.label(origin)} → {self.label(destination)}"

    # ---------- 分類 ----------
    @staticmethod
    def is_mac(code):
        """是不是城市群組代碼（XX 開頭，不是真實機場）。"""
        return bool(code) and code.upper().startswith("XX")

    def country(self, code):
        if code in self.by_code:
            cc = self.by_code[code]["country"]
            return COUNTRY_NAMES.get(cc, cc)
        if self.is_mac(code):
            members = self.mac_members.get(code, [])
            if members:
                cc = self.by_code[members[0]]["country"]
                return COUNTRY_NAMES.get(cc, cc)
        return ""

    def sort_key(self, code):
        """排序用：台灣站在前，其次依國別、群組排後面、再依代碼。"""
        info = self.by_code.get(code)
        cc = info["country"] if info else ("TW" if code == "XX3" else "")
        order = {"TW": 0, "JP": 1, "KR": 2, "TH": 3, "VN": 4}.get(cc, 9)
        return (order, 1 if self.is_mac(code) else 0, code)

    def all_codes(self, include_mac=True):
        codes = list(self.by_code)
        if include_mac:
            codes += [m for m in self.mac_members if m not in codes]
        return sorted(codes, key=self.sort_key)
