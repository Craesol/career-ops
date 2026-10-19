@file:OptIn(ExperimentalMaterial3Api::class)

package com.craesol.cajitaops

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

private const val PREFS = "cajita-ops"
private const val DEFAULT_URL = "https://192.168.1.176:8443"

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { MaterialTheme(colorScheme = darkColorScheme()) { Surface(Modifier.fillMaxSize()) { App() } } }
    }
}

/** A pending confirmation: shown as a dialog, runs [action] only on "Yes". */
private data class Confirm(val title: String, val text: String, val action: suspend () -> String)

@Composable
private fun App() {
    val ctx = LocalContext.current
    val prefs = remember { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }
    var url by remember { mutableStateOf(prefs.getString("url", DEFAULT_URL) ?: DEFAULT_URL) }
    var token by remember { mutableStateOf(prefs.getString("token", "") ?: "") }
    val api = remember(url, token) { if (token.isBlank()) null else Api(ctx, url, token) }
    var tab by remember { mutableIntStateOf(if (token.isBlank()) 4 else 0) }
    var confirm by remember { mutableStateOf<Confirm?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    fun ask(c: Confirm) { confirm = c }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            NavigationBar {
                listOf("Status", "Offers", "Tracker", "Logs", "Settings").forEachIndexed { i, label ->
                    NavigationBarItem(selected = tab == i, onClick = { tab = i }, icon = {}, label = { Text(label) })
                }
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            if (api == null && tab != 4) {
                Text("Set the server URL and token in Settings first.", Modifier.padding(16.dp))
            } else when (tab) {
                0 -> StatusScreen(api!!, ::ask)
                1 -> OffersScreen(api!!, ::ask)
                2 -> TrackerScreen(api!!, ::ask)
                3 -> LogsScreen(api!!)
                else -> SettingsScreen(url, token) { u, t ->
                    prefs.edit().putString("url", u.trim()).putString("token", t.trim()).apply()
                    url = u.trim(); token = t.trim(); tab = 0
                }
            }
        }
    }

    confirm?.let { c ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(c.title) },
            text = { Text(c.text) },
            confirmButton = {
                TextButton(onClick = {
                    confirm = null
                    scope.launch {
                        val msg = runCatching { withContext(Dispatchers.IO) { c.action() } }.getOrElse { "Failed: ${it.message}" }
                        snackbar.showSnackbar(msg)
                    }
                }) { Text("Yes") }
            },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

/** Loads [fetch] on first show and on every [reload]; exposes data or error. */
@Composable
private fun <T> rememberLoad(key: Any?, fetch: () -> T): Triple<T?, String?, () -> Unit> {
    var data by remember(key) { mutableStateOf<T?>(null) }
    var error by remember(key) { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    LaunchedEffect(key, tick) {
        error = null
        runCatching { withContext(Dispatchers.IO) { fetch() } }
            .onSuccess { data = it }
            .onFailure { error = it.message ?: it.javaClass.simpleName }
    }
    return Triple(data, error, { tick++ })
}

@Composable
private fun Header(title: String, onRefresh: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(title, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        TextButton(onClick = onRefresh) { Text("Refresh") }
    }
}

@Composable
private fun ErrorText(e: String?) {
    if (e != null) Text(e, color = Color(0xFFF87171), modifier = Modifier.padding(horizontal = 16.dp))
}

private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

@Composable
private fun StatusScreen(api: Api, ask: (Confirm) -> Unit) {
    val (st, err, reload) = rememberLoad(api) { api.status() to api.jobs() }
    Column(Modifier.verticalScroll(rememberScrollState())) {
        Header("CAJITA", reload)
        ErrorText(err)
        st?.let { (s, j) ->
            Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                Column(Modifier.padding(12.dp)) {
                    Text("Web: " + if (s.optBoolean("web")) "up" else "DOWN", color = if (s.optBoolean("web")) Color(0xFF4ADE80) else Color(0xFFF87171))
                    Text("Last hourly: " + s.optString("lastHourly", "—"), fontSize = 12.sp)
                    Text("OpenRouter requests used: " + s.opt("openrouterUsed"), fontSize = 12.sp)
                    val t = s.optJSONObject("tracker")
                    if (t != null) Text("Tracker: " + t.keys().asSequence().joinToString(" · ") { "$it ${t.optInt(it)}" }, fontSize = 12.sp)
                }
            }
            s.optJSONArray("tasks")?.objects()?.forEach { task ->
                Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(task.optString("name").removePrefix("career-ops-"), fontWeight = FontWeight.SemiBold)
                        if (!task.optBoolean("visible")) Text("not visible to this user", fontSize = 12.sp)
                        else {
                            val ok = task.optString("lastResult") == "0"
                            Text("${task.optString("state")} · last ${task.optString("lastRun")} · result ${task.optString("lastResult")}",
                                fontSize = 12.sp, color = if (ok) Color.Unspecified else Color(0xFFF87171))
                            Text("next ${task.optString("nextRun")}", fontSize = 12.sp)
                        }
                    }
                }
            }
            val jobs = j.optJSONArray("jobs")?.objects().orEmpty()
            if (jobs.isNotEmpty()) {
                Text("CV jobs", fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(16.dp, 12.dp, 16.dp, 4.dp))
                jobs.forEach { job ->
                    Text("${job.optString("status")} · ${job.optString("company")} — ${job.optString("title")}\n" +
                        (job.optString("pdf").takeIf { it.isNotBlank() && it != "null" } ?: job.optString("last")) +
                        (job.optString("error").takeIf { it.isNotBlank() && it != "null" }?.let { "\n$it" } ?: ""),
                        fontSize = 12.sp, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                }
            }
            Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { ask(Confirm("Run scan now?", "Starts the hourly scan task on CAJITA.") { api.runScan(); reload(); "Scan started" }) }) { Text("Run scan") }
                OutlinedButton(onClick = { ask(Confirm("Restart the web?", "Stops the web on :3000 and relaunches it (~20 s down). Running web jobs stop.") { api.restartWeb().toString(); reload(); "Web restarted" }) }) { Text("Restart web") }
            }
        }
    }
}

@Composable
private fun OffersScreen(api: Api, ask: (Confirm) -> Unit) {
    val ctx = LocalContext.current
    var days by remember { mutableIntStateOf(2) }
    val (data, err, reload) = rememberLoad(days) { api.finds(days) }
    Column {
        Header("New offers", reload)
        Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(1, 2, 7).forEach { d -> FilterChip(selected = days == d, onClick = { days = d }, label = { Text("${d}d") }) }
        }
        ErrorText(err)
        val finds = data?.optJSONArray("finds")?.objects().orEmpty()
        if (data != null && finds.isEmpty()) Text("Nothing new.", Modifier.padding(16.dp))
        LazyColumn {
            items(finds) { f ->
                val title = f.optString("title"); val company = f.optString("company"); val link = f.optString("url")
                Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text(title, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("$company · ${f.optString("location").ifBlank { "—" }}", fontSize = 12.sp)
                        val gate = f.optJSONObject("gate")
                        val pre = f.optJSONObject("prescore")
                        Text(
                            (if (gate == null) "gate: not checked" else if (gate.optString("verdict") == "fail") "⛔ ${gate.optString("gate")}: ${gate.optString("why")}" else "gate: pass") +
                                (pre?.let { " · prescore ${it.optString("score")}" } ?: ""),
                            fontSize = 12.sp,
                            color = if (gate?.optString("verdict") == "fail") Color(0xFFF87171) else Color.Unspecified,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) }) { Text("Open") }
                            TextButton(onClick = { ask(Confirm("Create CV?", "Evaluates \"$title\" at $company and builds the tailored CV PDF in output/ on CAJITA. Spends Claude usage.") { api.createCv(link, title, company); "CV job started — see Status" }) }) { Text("Create CV") }
                            TextButton(onClick = { ask(Confirm("Dismiss offer?", "Hides \"$title\" from new offers and closes its pipeline entry.") { api.dismiss(link, title, company); reload(); "Dismissed" }) }) { Text("Dismiss") }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TrackerScreen(api: Api, ask: (Confirm) -> Unit) {
    var filter by remember { mutableStateOf<String?>("Evaluated") }
    val (data, err, reload) = rememberLoad(filter) { api.tracker(filter) }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    val states = data?.optJSONArray("states")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty()
    Column {
        Header("Tracker", reload)
        Row(Modifier.padding(horizontal = 16.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = filter == null, onClick = { filter = null }, label = { Text("All") })
            listOf("Evaluated", "Applied", "Responded", "Assessment", "Interview", "Offer").forEach { s ->
                FilterChip(selected = filter == s, onClick = { filter = s }, label = { Text(s) })
            }
        }
        ErrorText(err)
        LazyColumn {
            items(data?.optJSONArray("rows")?.objects().orEmpty()) { r ->
                Card(onClick = { editing = r }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
                    Column(Modifier.padding(12.dp)) {
                        Text("#${r.optInt("row")} ${r.optString("company")}", fontWeight = FontWeight.SemiBold)
                        Text(r.optString("role"), fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("${r.optString("status")} · ${r.optString("score")} · ${r.optString("date")}", fontSize = 12.sp)
                    }
                }
            }
        }
    }
    editing?.let { r ->
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text("#${r.optInt("row")} → new status") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    states.filter { it != r.optString("status") }.forEach { s ->
                        TextButton(onClick = {
                            editing = null
                            ask(Confirm("Set #${r.optInt("row")} to $s?", "${r.optString("company")} — ${r.optString("role")}") {
                                api.setStatus(r.optInt("row"), s, "set from Cajita Ops"); reload(); "#${r.optInt("row")} → $s"
                            })
                        }) { Text(s) }
                    }
                }
            },
            confirmButton = { TextButton(onClick = { editing = null }) { Text("Close") } },
        )
    }
}

@Composable
private fun LogsScreen(api: Api) {
    var name by remember { mutableStateOf("hourly") }
    val (data, err, reload) = rememberLoad(name) { api.logs(name) }
    Column {
        Header("Logs", reload)
        Row(Modifier.padding(horizontal = 16.dp).horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("hourly", "nightly", "ats-full", "web", "ops").forEach { n -> FilterChip(selected = name == n, onClick = { name = n }, label = { Text(n) }) }
        }
        ErrorText(err)
        val lines = data?.optJSONArray("lines")?.let { a -> (0 until a.length()).joinToString("\n") { a.getString(it) } }.orEmpty()
        SelectionContainer(Modifier.verticalScroll(rememberScrollState()).horizontalScroll(rememberScrollState()).padding(16.dp)) {
            Text(lines, fontFamily = FontFamily.Monospace, fontSize = 11.sp)
        }
    }
}

@Composable
private fun SettingsScreen(url: String, token: String, onSave: (String, String) -> Unit) {
    var u by remember { mutableStateOf(url) }
    var t by remember { mutableStateOf(token) }
    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Settings", fontSize = 22.sp, fontWeight = FontWeight.SemiBold)
        OutlinedTextField(u, { u = it }, label = { Text("Server URL") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(t, { t = it }, label = { Text("Access token") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Text("At home use https://192.168.1.176:8443; away, your public IP or DDNS name with the forwarded port. The app only trusts CAJITA's own certificate.", fontSize = 12.sp)
        Button(onClick = { onSave(u, t) }, enabled = u.startsWith("https://") && t.isNotBlank()) { Text("Save") }
    }
}
