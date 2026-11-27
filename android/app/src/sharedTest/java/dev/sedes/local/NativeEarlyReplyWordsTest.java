package dev.sedes.local;

import static org.junit.Assert.*;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.stream.Collectors;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** Exercise both the host JDK's and the Android device's word iterator with the desktop client corpus. */
public class NativeEarlyReplyWordsTest {
    @Test public void responsiveWordCountingMatchesSharedSpeechExamples() throws Exception {
        InputStream input = getClass().getResourceAsStream("/early-reply-responsive.json");
        assertNotNull(input);
        NativeVoiceSettings settings = NativeVoiceSettings.defaults().patch(0,
            NativeVoiceJson.object("audioMode", "speak", "speechContent", "messages", "cleanSpeechText", true));
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            JSONArray cases = new JSONArray(reader.lines().collect(Collectors.joining("\n")));
            for (int i = 0; i < cases.length(); i++) {
                JSONObject example = cases.getJSONObject(i);
                String text = example.getString("text");
                NativeEarlyReply.Frame begin = new NativeEarlyReply.Frame(NativeVoiceJson.object(
                    "kind", "begin", "event", "turn.completed", "seq", 0, "generation", 5, "replyId", "a".repeat(64),
                    "threadId", "962d794f-b1b4-44bd-b8fa-c1701a606652", "threadTitle", "Project", "turnId", "turn",
                    "itemId", "message", "userInputRevision", 2, "rawStart", 0, "rawEnd", text.length(), "text", text, "paragraphEnd", false));
                NativeEarlyReply reply = new NativeEarlyReply(begin, 0);
                reply.freeze("responsive", settings, 1000);
                assertEquals(text, example.getBoolean("ready"), reply.next(null) != null);
            }
        }
    }
}
