import streamlit as st
import pandas as pd
import plotly.express as px

st.set_page_config(
    page_title="G-Asisit", layout="wide", initial_sidebar_state="collapsed"
)

st.title("🚀 G-Asisit - Trading League + ML + Mining")

tab1, tab2, tab3, tab4 = st.tabs(
    ["🏆 Tournaments", "📊 Portfolio", "📈 ML Signals", "⛏️ Mining"]
)

with tab1:
    st.header("Trading League")
    col1, col2 = st.columns(2)
    with col1:
        if st.button("Join Weekly League", use_container_width=True):
            st.success("Joined! Good luck!")
        if st.button("Start 1v1 Duel", use_container_width=True):
            st.success("Duel started!")
    with col2:
        st.metric("Your Rank", "#7 of 124")
        st.metric("Prize Pool", "$2,450")

with tab2:
    st.header("Your Portfolio")
    data = {
        "Asset": ["BTC", "ETH", "KAS"],
        "Amount": [0.52, 5.2, 12450],
        "Value $": [33280, 13420, 4180],
    }
    df = pd.DataFrame(data)
    st.dataframe(df, use_container_width=True)
    st.metric("Total Portfolio", "$50,880", "+1.8% today")

with tab3:
    st.header("VisualML Signals")
    signals = {
        "Symbol": ["BTC", "KAS", "ETH"],
        "Signal": ["BUY", "STRONG BUY", "HOLD"],
        "Confidence": [87, 94, 52],
    }
    st.dataframe(pd.DataFrame(signals), use_container_width=True)
    fig = px.bar(
        pd.DataFrame(signals),
        x="Symbol",
        y="Confidence",
        color="Signal",
        title="Signal Strength",
    )
    st.plotly_chart(fig, use_container_width=True)

with tab4:
    st.header("Project-Mine Dashboard")
    st.metric("Current Hashrate", "245 MH/s")
    st.metric("Today's Earnings", "142 KAS ($4.75)")
    st.button("Connect NiceHash / Start Mining", use_container_width=True)

st.caption("Built from your Trading-League, VisualML & Project-Mine files")
