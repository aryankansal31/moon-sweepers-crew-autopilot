import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import moon_trainer  # noqa: E402


class CrewLines(unittest.TestCase):
    def test_lines_from_status(self):
        self.assertEqual(moon_trainer.crew_lines({"crew": ["Sweeper: Clean, 120 kg delivered"]}),
                         ["Sweeper: Clean, 120 kg delivered"])

    def test_missing_key(self):
        self.assertEqual(moon_trainer.crew_lines({}), [])

    def test_no_status(self):
        self.assertEqual(moon_trainer.crew_lines(None), [])


class SetPaused(unittest.TestCase):
    """The panel only flips pause flags; hires and slot records written by the agent must survive."""

    BASE = {"games": {"slot1/abc": {"hired": ["sweeper", "hauler"], "hiredAt": {"sweeper": "t"}}},
            "paused": {"sweeper": False}, "slots": {"1": {"id": "abc", "maxPlaySeconds": 5}}}

    def test_pause_keeps_everything_else(self):
        out = json.loads(moon_trainer.set_paused(json.dumps(self.BASE), "hauler", True))
        self.assertTrue(out["paused"]["hauler"])
        self.assertFalse(out["paused"]["sweeper"])
        self.assertEqual(out["games"], self.BASE["games"])
        self.assertEqual(out["slots"], self.BASE["slots"])

    def test_missing_file_starts_empty(self):
        for text in (None, ""):
            out = json.loads(moon_trainer.set_paused(text, "sweeper", True))
            self.assertEqual(out["paused"], {"sweeper": True})

    def test_unreadable_file_is_never_overwritten(self):
        # A half-written or locked crew.json must not be replaced by {"paused": ...}: that would
        # erase every paid hire. set_paused returns None and the panel skips the write.
        for text in ("{broken", '{"games": {"slot1/a', "[]"):
            self.assertIsNone(moon_trainer.set_paused(text, "sweeper", True))

    def test_hired_kinds(self):
        self.assertEqual(moon_trainer.hired_kinds(json.dumps(self.BASE)), ["sweeper", "hauler"])
        self.assertEqual(moon_trainer.hired_kinds(None), [])


class HireRequest(unittest.TestCase):
    def test_request_names_the_helper_with_a_fresh_id(self):
        a = json.loads(moon_trainer.hire_request("sweeper"))
        b = json.loads(moon_trainer.hire_request("hauler"))
        self.assertEqual(a["hire"], "sweeper")
        self.assertEqual(b["hire"], "hauler")
        self.assertNotEqual(a["id"], b["id"])

    def test_reply_shown_only_for_our_request(self):
        status = {"crewReply": {"id": "r1", "text": "Dusty has joined your crew"}}
        self.assertEqual(moon_trainer.hire_reply(status, "r1"), "Dusty has joined your crew")
        self.assertIsNone(moon_trainer.hire_reply(status, "r2"))
        self.assertIsNone(moon_trainer.hire_reply(None, "r1"))


if __name__ == "__main__":
    unittest.main()
